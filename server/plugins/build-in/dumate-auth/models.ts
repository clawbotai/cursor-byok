import type { ModelDefinition, ModelSupport } from "cursor-byok:model";
import { accountData, consoleRequest, object, requiredText } from "./resources.ts";

/** 模型目录返回的地址会携带令牌，必须限制在官方模型网关。 */
export function gatewayUrl(value: unknown): string {
  const raw = requiredText(value, "网关地址");
  const url = new URL(raw);
  if (
    url.origin !== "https://dumate-svc.baidu.com" || url.username || url.password ||
    url.search || url.hash || !url.pathname.startsWith("/gateway/apis/") ||
    !url.pathname.endsWith("/chat/completions")
  ) {
    throw new Error("DuMate 模型网关地址不受支持");
  }
  return url.toString();
}

export const dumateModels: ModelSupport = {
  async list({ resource }, context): Promise<ModelDefinition[]> {
    if (!resource) throw new Error("请先导入 DuMate 账号");
    const body = await consoleRequest(accountData(resource), "model/list-all", context, {
      method: "POST",
      body: "{}",
    });
    if (!Array.isArray(body.items)) throw new Error("DuMate 模型目录响应缺少 items");
    if (typeof body.totalCount === "number" && body.totalCount > body.items.length) {
      throw new Error("DuMate 模型目录未完整返回，无法同步");
    }
    const models: ModelDefinition[] = [];
    for (const raw of body.items) {
      const item = object(raw);
      if (!item) throw new Error("DuMate 模型目录条目格式错误");
      // 自定义模型可走直连或其他协议，不能携带企业网关令牌转发。
      if (
        item.modelSource !== "preset" || item.accessStatus !== "Running" ||
        item.apiProtocol !== "openai"
      ) continue;
      if (item.modelCategory !== "LLM" && item.modelCategory !== "ITT") continue;
      models.push({
        id: requiredText(item.modelID, "模型标识"),
        displayName: requiredText(item.modelName, "模型名称"),
        ...(typeof item.modelDescription === "string"
          ? { description: item.modelDescription }
          : {}),
        ...(typeof item.maxOutputTokens === "number" && item.maxOutputTokens > 0
          ? { maxOutputTokens: item.maxOutputTokens }
          : {}),
        ...(item.modelCategory === "ITT" ? { capabilities: { images: true } } : {}),
        privateData: { url: gatewayUrl(item.url) },
      });
    }
    return models;
  },
};
