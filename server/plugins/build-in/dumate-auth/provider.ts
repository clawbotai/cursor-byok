import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type {
  ProviderInvokeInput,
  ProviderOutput,
  ProviderResult,
  ProviderSupport,
} from "cursor-byok:provider";
import { HttpError, streamOpenAiChat } from "cursor-byok:protocol/openai-chat";
import { dumateModels, gatewayUrl } from "./models.ts";
import {
  type AccountData,
  accountData,
  object,
  refreshAccessToken,
  RESOURCE_TYPE,
  USER_AGENT,
} from "./resources.ts";

function failed(error: unknown, data: AccountData): ProviderResult {
  const message = error instanceof Error ? error.message : String(error);
  const privateData = data as unknown as JsonValue;
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) {
      return {
        status: "resource-error",
        message,
        patch: {
          privateData,
          state: {
            status: "invalid",
            message: "DuMate 鉴权失败，请在 DuMate 中重新登录，然后重新添加账号",
          },
        },
      };
    }
    if (error.status === 429) {
      return {
        status: "resource-error",
        message,
        patch: {
          privateData,
          state: { status: "cooling", retryAtMs: Date.now() + 60_000, message: "DuMate 请求限流" },
        },
      };
    }
  }
  return { status: "request-error", message, patch: { privateData } };
}

async function streamOnce(
  data: AccountData,
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
) {
  await streamOpenAiChat(
    {
      url: gatewayUrl(object(input.model.privateData)?.url),
      model: input.model.id,
      // 网关未验证支持思考档位、快速通道或缓存路由参数，只发送标准聊天字段。
      request: {
        ...input.request,
        reasoning: { enabled: input.request.reasoning.enabled, effort: null },
        latency: "standard",
        cacheKey: null,
      },
      headers: {
        authorization: `Bearer ${data.accessToken}`,
        "x-dumate-prd-source": "enterprise",
        "user-agent": USER_AGENT,
      },
    },
    output,
    context,
  );
}

export const dumateProvider: ProviderSupport = {
  id: "dumate",
  displayName: "DuMate",
  description: {
    "zh-CN": "使用 DuMate 企业账号的预置模型。",
    "en-US": "Use preset models from a DuMate enterprise account.",
  },
  providerType: "dumate",
  resourceType: RESOURCE_TYPE,
  models: dumateModels,
  async invoke(input, output, context) {
    if (!input.resource) return { status: "request-error", message: "请先导入 DuMate 账号" };
    let data = accountData(input.resource);
    try {
      if (
        !data.accessToken || data.expiresAtMs === null || data.expiresAtMs <= Date.now() + 60_000
      ) {
        data = await refreshAccessToken(data, context);
      }
    } catch (error) {
      return failed(error, data);
    }
    try {
      await streamOnce(data, input, output, context);
    } catch (error) {
      // 非 2xx 在 SDK 输出事件前抛出；仅此处允许换令牌重试一次。
      if (!(error instanceof HttpError) || error.status !== 401) return failed(error, data);
      try {
        data = await refreshAccessToken(data, context);
        await streamOnce(data, input, output, context);
      } catch (retryError) {
        return failed(retryError, data);
      }
    }
    return { status: "completed", patch: { privateData: data as unknown as JsonValue } };
  },
};
