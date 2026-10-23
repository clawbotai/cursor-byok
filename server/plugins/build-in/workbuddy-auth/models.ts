import type { ModelDefinition, ModelSupport } from "cursor-byok:model";
import { accountData, accountHeaders, API_ORIGIN, parseEnvelope } from "./resources.ts";

const MODELS_URL = `${API_ORIGIN}/v2/enterprises/personal/models`;

/** 动态目录不可用时的回退;WorkBuddy 网关的 OpenAI 兼容模型标识。 */
export const FALLBACK_MODELS: ModelDefinition[] = [
  { id: "auto", displayName: "Auto" },
  { id: "fast-model", displayName: "Fast", maxOutputTokens: 48000 },
  { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", maxOutputTokens: 48000 },
  { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", maxOutputTokens: 48000 },
  { id: "kimi-k2.7", displayName: "Kimi K2.7", maxOutputTokens: 48000 },
  { id: "glm-5.3", displayName: "GLM 5.3", maxOutputTokens: 48000 },
  { id: "glm-5.3-flash", displayName: "GLM 5.3 Flash", maxOutputTokens: 48000 },
  { id: "glm-5v-turbo", displayName: "GLM 5V Turbo", capabilities: { images: true } },
  { id: "hunyuan-2.0-thinking", displayName: "Hunyuan 2.0 Thinking" },
];

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function count(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : null;
  return parsed !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** 把模型 ID 变成可读名称,如 deepseek-v4-pro → Deepseek V4 Pro。 */
function displayName(id: string): string {
  return id
    .split("-")
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

/** 解析 /v2/enterprises/personal/models 的 data.models 数组。 */
export function parseWorkBuddyModels(body: unknown): ModelDefinition[] {
  const root = object(body);
  const source = Array.isArray(root?.models) ? root!.models : null;
  if (!source) throw new Error("WorkBuddy model discovery response does not contain a model list");
  const seen = new Set<string>();
  const models: ModelDefinition[] = [];
  for (const raw of source) {
    const model = object(raw);
    if (!model) continue;
    const id = text(model.id ?? model.name);
    if (!id || seen.has(id)) continue;
    // 图像生成模型不是聊天模型,跳过。
    if (id.startsWith("hunyuan-image")) continue;
    seen.add(id);
    const label = text(model.name) ?? displayName(id);
    const maxOutputTokens = count(model.maxOutputTokens ?? model.max_output_tokens);
    const supportsImages = model.supportsImages === true || model.supports_images === true;
    models.push({
      id,
      displayName: label === id ? displayName(id) : label,
      ...(maxOutputTokens !== null ? { maxOutputTokens } : {}),
      ...(supportsImages ? { capabilities: { images: true } } : {}),
    });
  }
  return models;
}

export const workbuddyModels: ModelSupport = {
  list: async ({ resource }, context): Promise<ModelDefinition[]> => {
    if (!resource) throw new Error("add a WorkBuddy account before syncing models");
    const headers = accountHeaders(accountData(resource));
    const response = await context.network.fetch(MODELS_URL, { method: "GET", headers });
    if (response.status < 200 || response.status >= 300) return FALLBACK_MODELS;
    let envelope;
    try {
      envelope = parseEnvelope(response.body);
    } catch {
      return FALLBACK_MODELS;
    }
    if (envelope.code !== 0 || !envelope.data) return FALLBACK_MODELS;
    let models: ModelDefinition[];
    try {
      models = parseWorkBuddyModels(envelope.data);
    } catch {
      return FALLBACK_MODELS;
    }
    return models.length > 0 ? models : FALLBACK_MODELS;
  },
};
