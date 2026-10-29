import type { JsonValue, NetworkRequestInit, PluginContext } from "cursor-byok:plugin";
import type {
  ResourceImportSupport,
  ResourcePatch,
  ResourceSnapshot,
  ResourceView,
} from "cursor-byok:resource";
import { HttpError } from "cursor-byok:protocol/openai-chat";

export const RESOURCE_TYPE = "dumate-account";
export const USER_AGENT = "DumateApp/1.0.88.419";
export type AccountData = {
  apiBaseUrl: string;
  sessionId: string;
  userId: string;
  displayName: string;
  tenantName: string;
  accessToken: string | null;
  expiresAtMs: number | null;
};

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`DuMate 缺少${field}`);
  return value.trim();
}

export function accountData(resource: ResourceSnapshot): AccountData {
  return resource.privateData as unknown as AccountData;
}

/** 仅支持已验证的公网企业控制台；凭证不能随任意 URL 导入。 */
function parseCredential(value: unknown): Pick<AccountData, "apiBaseUrl" | "sessionId"> {
  const input = object(value);
  const apiBaseUrl = requiredText(input?.apiBaseUrl, "企业地址").replace(/\/$/, "");
  if (!/^https:\/\/[a-z0-9-]+\.dumate\.cn$/.test(apiBaseUrl)) {
    throw new Error("DuMate 企业地址必须为 HTTPS 的企业租户域名");
  }
  const sessionId = requiredText(input?.sessionId, "会话");
  if (/[\s;,"\\\x00-\x1f\x7f]/.test(sessionId)) throw new Error("DuMate 会话包含非法字符");
  return { apiBaseUrl, sessionId };
}

/** 控制台只收到自己的会话 Cookie；网关使用另行换取的短期令牌。 */
export async function consoleRequest(
  data: Pick<AccountData, "apiBaseUrl" | "sessionId">,
  path: string,
  context: PluginContext,
  init: NetworkRequestInit = {},
): Promise<Record<string, unknown>> {
  const response = await context.network.fetch(
    `${data.apiBaseUrl}/api/dumate-enterprise/app/v1/${path}`,
    {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: `dumate_enterprise_sessionid=${data.sessionId}`,
        "user-agent": USER_AGENT,
      },
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new HttpError(
      response.status,
      response.status === 401 || response.status === 403
        ? "DuMate 登录已失效，请在 DuMate 中重新登录，然后重新添加账号"
        : "DuMate 控制台请求失败",
    );
  }
  const body = object(JSON.parse(response.body));
  if (!body) throw new Error("DuMate 控制台响应格式错误");
  return body;
}

export const credentialImport: ResourceImportSupport = {
  displayName: { "zh-CN": "从本机 DuMate 添加", "en-US": "Add from DuMate on this Mac" },
  description: {
    "zh-CN": "先在 DuMate 中登录企业账号，再点击下方按钮。将自动添加当前账号并同步可用模型。",
    "en-US":
      "Sign in to your enterprise account in DuMate, then click below to add the current account and sync its models automatically.",
  },
  accept: [],
  localSource: "dumate",
  multiple: false,
  async parse(files, context) {
    const resources = [];
    for (const file of files) {
      const credential = parseCredential(JSON.parse(file.content));
      const user = await consoleRequest(credential, "user", context);
      const userId = requiredText(user.userId, "账号标识");
      const data: AccountData = {
        ...credential,
        userId,
        displayName: requiredText(user.displayName, "账号名称"),
        tenantName: requiredText(user.tenantName, "企业名称"),
        accessToken: null,
        expiresAtMs: null,
      };
      resources.push({
        key: `dumate:${data.apiBaseUrl}:${userId}`,
        privateData: data as unknown as JsonValue,
      });
    }
    return { resources };
  },
};

export function presentAccount(resource: ResourceSnapshot): ResourceView {
  const data = accountData(resource);
  return { displayName: data.displayName, description: data.tenantName };
}

export async function refreshAccessToken(
  data: AccountData,
  context: PluginContext,
): Promise<AccountData> {
  const body = await consoleRequest(data, "user_token", context);
  const accessToken = requiredText(body.token, "网关令牌");
  const expiresAtMs = Date.parse(requiredText(body.expiredAt, "令牌有效期"));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error("DuMate 网关令牌有效期无效");
  }
  return { ...data, accessToken, expiresAtMs };
}

export async function refreshAccount(
  resource: ResourceSnapshot,
  context: PluginContext,
): Promise<ResourcePatch> {
  try {
    const data = await refreshAccessToken(accountData(resource), context);
    return { privateData: data as unknown as JsonValue, state: { status: "ready" } };
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      return { state: { status: "invalid", message: "请在 DuMate 中重新登录，然后重新添加账号" } };
    }
    throw error;
  }
}
