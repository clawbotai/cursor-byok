import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type {
  ResourceDraft,
  ResourceMetric,
  ResourcePatch,
  ResourceSnapshot,
  ResourceState,
  ResourceView,
} from "cursor-byok:resource";

export const RESOURCE_TYPE = "workbuddy-account";

/** 上游 API 主源;登录、刷新、计费与模型目录都挂在同一网关下。 */
export const API_ORIGIN = "https://copilot.tencent.com";
export const ACCOUNT_URL = `${API_ORIGIN}/v2/plugin/account`;
export const REFRESH_URL = `${API_ORIGIN}/v2/plugin/auth/token/refresh`;
const BILLING_URL = `${API_ORIGIN}/billing/meter/get-user-resource-summary`;

/** 官方 CLI 的 User-Agent;缺失或非标值可能触发上游风控拦截。 */
export const USER_AGENT = "CLI/2.63.2 CodeBuddy/2.63.2";
const DEFAULT_DOMAIN = "www.codebuddy.cn";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type AccountQuota = {
  remainingCredits: number | null;
  totalCredits: number | null;
  isPaidUser: boolean | null;
  updatedAtMs: number;
};

/** 单条 workbuddy-account 资源的 privateData 形状。 */
export type AccountData = {
  accessToken: string;
  refreshToken: string | null;
  uid: string | null;
  displayName: string;
  domain: string;
  expiresAtMs: number | null;
  refreshExpiresAtMs: number | null;
  quota: AccountQuota | null;
};

export type CredentialCandidate = {
  accessToken: string;
  refreshToken?: string | null;
  uid?: string | null;
  displayName?: string | null;
  domain?: string | null;
  expiresIn?: number | null;
  refreshExpiresIn?: number | null;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** 计划过期毫秒值;兼容已是毫秒的 expiresAt 与秒级的 expiresIn。 */
export function expiryMs(expiresAt: unknown, expiresIn: unknown, nowMs: number): number | null {
  const at = number(expiresAt);
  if (at !== null) return at > 10_000_000_000 ? at : at * 1000;
  const inSeconds = number(expiresIn);
  return inSeconds === null ? null : nowMs + inSeconds * 1000;
}

async function tokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(
    new Uint8Array(digest).slice(0, 8),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function accountData(resource: ResourceSnapshot): AccountData {
  const data = object(resource.privateData);
  const accessToken = text(data?.accessToken);
  if (!accessToken) throw new Error("WorkBuddy account resource is missing its access token");
  return {
    accessToken,
    refreshToken: text(data?.refreshToken),
    uid: text(data?.uid),
    displayName: text(data?.displayName) ?? "WorkBuddy account",
    domain: text(data?.domain) ?? DEFAULT_DOMAIN,
    expiresAtMs: number(data?.expiresAtMs),
    refreshExpiresAtMs: number(data?.refreshExpiresAtMs),
    quota: (data?.quota ?? null) as AccountQuota | null,
  };
}

/** 上游统一响应包装 {code, msg, data};code === 0 视为成功。 */
export type Envelope = { code: number; msg: string | null; data: Record<string, unknown> | null };

export function parseEnvelope(body: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("WorkBuddy API returned invalid JSON");
  }
  const root = object(parsed);
  return {
    code: number(root?.code) ?? -1,
    msg: text(root?.msg ?? root?.message),
    data: object(root?.data),
  };
}

export async function credentialDraft(credential: CredentialCandidate): Promise<ResourceDraft> {
  const nowMs = Date.now();
  const identity = credential.uid ?? await tokenFingerprint(credential.accessToken);
  const data: AccountData = {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken ?? null,
    uid: credential.uid ?? null,
    displayName: credential.displayName ?? "WorkBuddy account",
    domain: credential.domain ?? DEFAULT_DOMAIN,
    expiresAtMs: expiryMs(null, credential.expiresIn, nowMs),
    refreshExpiresAtMs: expiryMs(null, credential.refreshExpiresIn, nowMs),
    quota: null,
  };
  return {
    key: `workbuddy:${identity}`,
    privateData: data as unknown as JsonValue,
  };
}

/** 带 WorkBuddy 网关约定头的认证请求头;再叠加 content-type 由调用方决定。 */
export function accountHeaders(data: AccountData): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${data.accessToken}`,
    "user-agent": USER_AGENT,
    "x-domain": data.domain,
  };
  if (data.uid) headers["x-user-id"] = data.uid;
  return headers;
}

/** 刷新 WorkBuddy 访问令牌;返回合并后的新账号数据。401/失效时抛错。 */
export async function refreshAccessToken(
  data: AccountData,
  context: PluginContext,
): Promise<AccountData> {
  if (!data.refreshToken) throw new Error("WorkBuddy account has no refresh token");
  const headers = {
    ...accountHeaders(data),
    "content-type": "application/json",
    "x-refresh-token": data.refreshToken,
    "x-auth-refresh-source": "plugin",
  };
  const response = await context.network.fetch(REFRESH_URL, {
    method: "POST",
    headers,
    body: "{}",
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`WorkBuddy token refresh failed (HTTP ${response.status}): ${response.body}`);
  }
  const envelope = parseEnvelope(response.body);
  if (envelope.code !== 0 || !envelope.data) {
    throw new Error(envelope.msg ?? "WorkBuddy token refresh was rejected");
  }
  const accessToken = text(envelope.data.accessToken);
  if (!accessToken) throw new Error("WorkBuddy token refresh response is missing accessToken");
  const nowMs = Date.now();
  return {
    ...data,
    accessToken,
    refreshToken: text(envelope.data.refreshToken) ?? data.refreshToken,
    uid: text(envelope.data.uid) ?? data.uid,
    domain: text(envelope.data.domain) ?? data.domain,
    expiresAtMs: expiryMs(envelope.data.expiresAt, envelope.data.expiresIn, nowMs),
    refreshExpiresAtMs: expiryMs(
      envelope.data.refreshExpiresAt,
      envelope.data.refreshExpiresIn,
      nowMs,
    ) ?? data.refreshExpiresAtMs,
    quota: data.quota,
  };
}

/** 调用前续期:令牌临近过期且有刷新令牌时先换新,失败沿用旧令牌由 401 兜底。 */
export async function ensureFreshToken(
  data: AccountData,
  context: PluginContext,
): Promise<AccountData> {
  if (!data.refreshToken || data.expiresAtMs === null) return data;
  if (Date.now() < data.expiresAtMs - REFRESH_SKEW_MS) return data;
  try {
    return await refreshAccessToken(data, context);
  } catch {
    return data;
  }
}

/** 解析腾讯计费汇总的 data 字段,聚合各资源包的周期额度。 */
export function parseBillingSummary(body: unknown, nowMs = Date.now()): AccountQuota {
  const root = object(body);
  const packages = Array.isArray(root?.Packages) ? root!.Packages : [];
  let total = 0;
  let remain = 0;
  let seen = false;
  for (const raw of packages) {
    const entry = object(raw);
    if (!entry) continue;
    const cycleTotal = number(entry.CycleTotalCapacity);
    const cycleRemain = number(entry.CycleRemainCapacity);
    if (cycleTotal === null && cycleRemain === null) continue;
    seen = true;
    total += cycleTotal ?? 0;
    remain += cycleRemain ?? 0;
  }
  return {
    remainingCredits: seen ? remain : null,
    totalCredits: seen ? total : null,
    isPaidUser: boolean(root?.IsPaidUser),
    updatedAtMs: nowMs,
  };
}

export function quotaState(quota: AccountQuota | null): ResourceState {
  if (quota !== null && quota.remainingCredits !== null && quota.remainingCredits <= 0) {
    return { status: "cooling", message: "WorkBuddy credits are exhausted" };
  }
  return { status: "ready" };
}

export function quotaExhaustedPatch(data: AccountData, nowMs = Date.now()): ResourcePatch {
  const quota: AccountQuota = {
    remainingCredits: 0,
    totalCredits: data.quota?.totalCredits ?? null,
    isPaidUser: data.quota?.isPaidUser ?? null,
    updatedAtMs: nowMs,
  };
  return {
    privateData: { ...data, quota } as unknown as JsonValue,
    state: quotaState(quota),
  };
}

export function presentAccount(resource: ResourceSnapshot): ResourceView {
  const data = accountData(resource);
  const metrics: ResourceMetric[] = [];
  if (data.quota?.remainingCredits !== null && data.quota?.remainingCredits !== undefined) {
    metrics.push({
      id: "credits",
      label: { "en-US": "Credits left", "zh-CN": "剩余积分" },
      unit: "count",
      value: data.quota.remainingCredits,
    });
  }
  return {
    displayName: data.displayName,
    ...(data.quota?.isPaidUser === true
      ? { description: { "en-US": "Paid plan", "zh-CN": "付费版" } }
      : {}),
    ...(metrics.length > 0 ? { metrics } : {}),
  };
}

async function fetchQuota(data: AccountData, context: PluginContext): Promise<AccountQuota> {
  const response = await context.network.fetch(BILLING_URL, {
    method: "POST",
    headers: { ...accountHeaders(data), "content-type": "application/json" },
    body: "{}",
  });
  if (response.status === 401) throw new Error("unauthorized");
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`WorkBuddy billing lookup failed (HTTP ${response.status}): ${response.body}`);
  }
  const envelope = parseEnvelope(response.body);
  if (envelope.code !== 0 || !envelope.data) {
    throw new Error(envelope.msg ?? "WorkBuddy billing lookup was rejected");
  }
  return parseBillingSummary(envelope.data);
}

export async function refreshAccount(
  resource: ResourceSnapshot,
  context: PluginContext,
): Promise<ResourcePatch> {
  let data = accountData(resource);
  try {
    const quota = await fetchQuota(data, context);
    data = { ...data, quota };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "unauthorized") throw error;
    // 计费接口 401:先续期再重试一次,仍失败才判定凭证失效。
    try {
      data = await refreshAccessToken(data, context);
    } catch {
      return {
        state: { status: "invalid", message: "WorkBuddy authorization expired; sign in again" },
      };
    }
    try {
      data = { ...data, quota: await fetchQuota(data, context) };
    } catch {
      return {
        privateData: data as unknown as JsonValue,
        state: { status: "invalid", message: "WorkBuddy authorization expired; sign in again" },
      };
    }
  }
  return {
    privateData: data as unknown as JsonValue,
    state: quotaState(data.quota),
  };
}
