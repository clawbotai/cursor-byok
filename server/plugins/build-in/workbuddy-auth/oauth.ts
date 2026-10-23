import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type { OAuth2AddMethod, OAuth2Begin, OAuth2Poll } from "cursor-byok:resource";
import {
  ACCOUNT_URL,
  API_ORIGIN,
  type CredentialCandidate,
  credentialDraft,
  parseEnvelope,
} from "./resources.ts";

/** 发起登录会话与轮询令牌的端点;与官方 CLI 的外部链接登录同源。 */
const AUTH_STATE_URL = `${API_ORIGIN}/v2/plugin/auth/state?platform=console`;
const AUTH_TOKEN_URL = `${API_ORIGIN}/v2/plugin/auth/token`;

/** 匿名请求要求显式关闭默认鉴权头,否则网关按携带令牌校验并拒绝。 */
const ANONYMOUS_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  "x-no-authorization": "true",
  "x-no-user-id": "true",
  "x-no-enterprise-id": "true",
  "x-no-department-info": "true",
};

const POLL_INTERVAL_MS = 2000;
const FLOW_LIFETIME_MS = 5 * 60 * 1000;

type Session = {
  state: string;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseSession(value: JsonValue): Session {
  const session = object(value);
  const state = text(session?.state);
  if (!state) throw new Error("WorkBuddy OAuth session is invalid");
  return { state };
}

async function begin(context: PluginContext): Promise<OAuth2Begin> {
  const response = await context.network.fetch(AUTH_STATE_URL, {
    method: "POST",
    headers: ANONYMOUS_HEADERS,
    body: "{}",
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Failed to start WorkBuddy authorization (HTTP ${response.status}): ${response.body}`,
    );
  }
  const envelope = parseEnvelope(response.body);
  const authUrl = text(envelope.data?.authUrl ?? envelope.data?.auth_url);
  const state = text(envelope.data?.state);
  if (envelope.code !== 0 || !authUrl || !state) {
    throw new Error(envelope.msg ?? "WorkBuddy authorization response is incomplete");
  }
  // WorkBuddy 是扫码/网页确认登录,没有需要抄写的设备码。
  const session: Session = { state };
  return {
    session: session as unknown as JsonValue,
    userCode: "",
    verificationUrl: authUrl,
    expiresAtMs: Date.now() + FLOW_LIFETIME_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

/** 令牌响应可能是 auth 对象本身,也可能包在 data.auth 里。 */
function authPayload(data: Record<string, unknown>): Record<string, unknown> | null {
  return object(data.auth) ?? data;
}

async function fetchDisplayName(
  accessToken: string,
  context: PluginContext,
): Promise<{ uid: string | null; nickname: string | null }> {
  const response = await context.network.fetch(ACCOUNT_URL, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "CLI/2.63.2 CodeBuddy/2.63.2",
    },
  });
  if (response.status < 200 || response.status >= 300) return { uid: null, nickname: null };
  const envelope = parseEnvelope(response.body);
  return {
    uid: text(envelope.data?.uid),
    nickname: text(envelope.data?.nickname),
  };
}

async function completed(
  payload: Record<string, unknown>,
  context: PluginContext,
): Promise<OAuth2Poll> {
  const accessToken = text(payload.accessToken ?? payload.access_token);
  if (!accessToken) return { status: "pending" };
  const account = await fetchDisplayName(accessToken, context);
  const credential: CredentialCandidate = {
    accessToken,
    refreshToken: text(payload.refreshToken ?? payload.refresh_token),
    uid: account.uid,
    displayName: account.nickname,
    domain: text(payload.domain),
    expiresIn: typeof payload.expiresIn === "number" ? payload.expiresIn : null,
    refreshExpiresIn: typeof payload.refreshExpiresIn === "number"
      ? payload.refreshExpiresIn
      : null,
  };
  return { status: "completed", resources: [await credentialDraft(credential)] };
}

async function poll(sessionValue: JsonValue, context: PluginContext): Promise<OAuth2Poll> {
  const session = parseSession(sessionValue);
  const response = await context.network.fetch(`${AUTH_TOKEN_URL}?state=${session.state}`, {
    method: "GET",
    headers: ANONYMOUS_HEADERS,
  });
  if (response.status < 200 || response.status >= 300) {
    // 网关在用户完成扫码前返回非 2xx;按流程语义视为继续等待。
    return { status: "pending" };
  }
  const envelope = parseEnvelope(response.body);
  if (envelope.code !== 0) {
    const message = (envelope.msg ?? "").toLowerCase();
    if (message.includes("expire") || message.includes("过期")) {
      return { status: "failed", message: envelope.msg ?? "WorkBuddy authorization expired" };
    }
    return { status: "pending" };
  }
  const payload = envelope.data ? authPayload(envelope.data) : null;
  if (!payload || !text(payload.accessToken ?? payload.access_token)) {
    return { status: "pending" };
  }
  return await completed(payload, context);
}

export const workbuddyOAuth: OAuth2AddMethod = {
  type: "oauth2.0",
  id: "workbuddy-web",
  displayName: {
    "en-US": "Sign in with WorkBuddy",
    "zh-CN": "使用 WorkBuddy 登录",
  },
  description: {
    "en-US":
      "Open the Tencent WorkBuddy authorization page, confirm with WeChat, then the account is added automatically.",
    "zh-CN": "打开腾讯 WorkBuddy 授权页,微信确认后自动添加账号。",
  },
  begin,
  poll,
};
