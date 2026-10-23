import type {
  ProviderInvokeInput,
  ProviderOutput,
  ProviderResult,
  ProviderSupport,
} from "cursor-byok:provider";
import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import { HttpError, streamOpenAiChat } from "cursor-byok:protocol/openai-chat";
import { workbuddyModels } from "./models.ts";
import {
  type AccountData,
  accountData,
  accountHeaders,
  API_ORIGIN,
  ensureFreshToken,
  quotaExhaustedPatch,
  refreshAccessToken,
  RESOURCE_TYPE,
  USER_AGENT,
} from "./resources.ts";

const CHAT_URL = `${API_ORIGIN}/v2/chat/completions`;
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

/** 流内错误只有文本可用,按积分/频控关键词分类。 */
export function isQuotaError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("credits exhausted") ||
    lower.includes("credit exhausted") ||
    lower.includes("insufficient credit") ||
    lower.includes("insufficient credits") ||
    lower.includes("quota_exceeded") ||
    lower.includes("6004");
}

function invalidResult(message: string, stateMessage: string): ProviderResult {
  return {
    status: "resource-error",
    message,
    patch: { state: { status: "invalid", message: stateMessage } },
  };
}

/** 把上游失败归类为资源失效、额度冷却或普通请求错误。 */
function classify(error: unknown, data: AccountData): ProviderResult {
  if (error instanceof HttpError) {
    if ((error.status === 401 || error.status === 403) && !isQuotaError(error.body)) {
      return invalidResult(error.message, "WorkBuddy authorization expired; sign in again");
    }
    if (error.status === 429) {
      return {
        status: "resource-error",
        message: error.message,
        patch: {
          privateData: data as unknown as JsonValue,
          state: {
            status: "cooling",
            retryAtMs: Date.now() + RATE_LIMIT_COOLDOWN_MS,
            message: "WorkBuddy rate limited",
          },
        },
      };
    }
    if (isQuotaError(error.body)) {
      return {
        status: "resource-error",
        message: error.message,
        patch: quotaExhaustedPatch(data),
      };
    }
    return { status: "request-error", message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (isQuotaError(message)) {
    return { status: "resource-error", message, patch: quotaExhaustedPatch(data) };
  }
  return { status: "request-error", message };
}

async function streamOnce(
  data: AccountData,
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
): Promise<ProviderResult> {
  await streamOpenAiChat(
    {
      url: CHAT_URL,
      model: input.model.id,
      // 网关对未知采样参数可能整体拒绝;思考档位由模型自身决定,
      // 输出预算不透传,交由上游默认值。
      request: {
        ...input.request,
        reasoning: { enabled: input.request.reasoning.enabled, effort: null },
        latency: "standard",
        maxOutputTokens: null,
      },
      headers: { ...accountHeaders(data), "user-agent": USER_AGENT },
    },
    output,
    context,
  );
  return { status: "completed" };
}

async function invoke(
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
): Promise<ProviderResult> {
  if (!input.resource) {
    return { status: "request-error", message: "add a WorkBuddy account before calling it" };
  }
  let data: AccountData;
  try {
    data = await ensureFreshToken(accountData(input.resource), context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "request-error", message };
  }
  const originalAccessToken = data.accessToken;

  try {
    const result = await streamOnce(data, input, output, context);
    // 调用前续期可能换了新令牌;成功后持久化。
    return result.status === "completed" && data.accessToken !== originalAccessToken
      ? { status: "completed", patch: { privateData: data as unknown as JsonValue } }
      : result;
  } catch (error) {
    // 401/403(非额度)先续期重试一次;此时尚未发出任何事件,重试不会重复输出。
    const refreshable = error instanceof HttpError &&
      (error.status === 401 || error.status === 403) &&
      !isQuotaError(error.body) &&
      data.refreshToken !== null;
    if (!refreshable) return classify(error, data);
    let refreshed: AccountData;
    try {
      refreshed = await refreshAccessToken(data, context);
    } catch {
      return invalidResult(error.message, "WorkBuddy authorization expired; sign in again");
    }
    try {
      const retried = await streamOnce(refreshed, input, output, context);
      return retried.status === "completed"
        ? { status: "completed", patch: { privateData: refreshed as unknown as JsonValue } }
        : retried;
    } catch (retryError) {
      return classify(retryError, refreshed);
    }
  }
}

export const workbuddyProvider: ProviderSupport = {
  id: "workbuddy",
  displayName: "Tencent WorkBuddy",
  description: {
    "en-US": "Use the models included with a Tencent WorkBuddy subscription.",
    "zh-CN": "使用腾讯 WorkBuddy 订阅自带的模型。",
  },
  providerType: "workbuddy",
  resourceType: RESOURCE_TYPE,
  models: workbuddyModels,
  invoke,
};
