# 本机模型 API

服务端口提供 `GET /v1/models` 和 `POST /v1/chat/completions`，可供 Moss 等支持 OpenAI Chat Completions 的客户端复用已配置的插件模型。
使用应用设置中的服务端口，不能使用 Cursor 专用拦截代理端口。

```text
客户端 → 本机模型 API → 现有 ProviderRouter → 插件模型与账号资源 → 上游服务
```

## 使用

API 基础地址示例为 `http://127.0.0.1:50566/v1`，协议选择 `openai-completions`。
入口没有新增 API 密钥鉴权；要求填写密钥的客户端可使用 `local` 占位值。
沿用现有服务监听配置，仅限可信本机使用，不应公开暴露。

模型目录只列出已配置插件提供方的已启用模型，返回的 `id` 可直接用于请求：

```json
{
  "model": "plugin:dev.cursorbyok.plugins.antigravity-auth/antigravity/gemini-3.8-flash-high",
  "messages": [{"role": "user", "content": "请回复 OK"}],
  "max_tokens": 1024,
  "stream": true
}
```

## 当前支持范围

- 文本、系统指令、内联 base64 图片、工具定义、工具调用和工具结果。
- 流式或非流式回复，思考文本、用量与结束原因。
- `max_tokens` / `max_completion_tokens` 输出预算。
- Antigravity 工具续轮通过 `reasoning_details` 的加密状态字段保留签名；客户端需要原样保存和重放此扩展。Moss 使用的 Pi 0.84.2 已支持。
- 早期上游错误在发送流式响应头前返回；流内错误明确返回 `error`。插件最终结果读完后才结束流，以保存刷新后的账号状态。

这不是全部 OpenAI API 的实现：不提供 Responses API，不代理远程图片下载，不透传其他采样参数，也不列出内置 API Key 模型。
Google 插件 0.1.10 透传调用方输出预算，并保留工具参数中 `title`、`type` 等与 Schema 关键字同名的属性。
Google 插件 0.1.12 将自动令牌刷新与额度查询分开；地区、认证和限流错误保留原始状态，不再被后续端点的连接错误覆盖；流缺少结束原因时明确报错，输出预算耗尽时返回 `length`。
访问 Antigravity 使用的是 Google Cloud Code 接口，不经过 Gemini 网页。系统代理需要覆盖 `cloudcode-pa.googleapis.com`、`daily-cloudcode-pa.googleapis.com`、`daily-cloudcode-pa.sandbox.googleapis.com` 和 `oauth2.googleapis.com`；网页可用不能代替这些接口的连通性与地区校验。
上游模型可用性、认证和额度仍由对应服务决定。
