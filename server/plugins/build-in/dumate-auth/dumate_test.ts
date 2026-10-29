import type {
  JsonValue,
  NetworkEventStream,
  NetworkRequestInit,
  PluginContext,
} from "../../../src/plugin/sdk/plugin.ts";
import type { LlmRequest, ModelEvent } from "../../../src/plugin/sdk/provider.ts";
import type { ResourceSnapshot } from "../../../src/plugin/sdk/resource.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`预期 ${JSON.stringify(expected)}，收到 ${JSON.stringify(actual)}`);
  }
}
function assert(value: unknown): asserts value {
  if (!value) throw new Error("断言失败");
}
async function rejects(run: () => Promise<unknown>, message: string) {
  try {
    await run();
  } catch (error) {
    assert(error instanceof Error && error.message.includes(message));
    return;
  }
  throw new Error("预期操作失败");
}
const origin = "https://zhongzhi.dumate.cn";
const chatUrl = "https://dumate-svc.baidu.com/gateway/apis/ais-v2/chat/completions";
const credential = { apiBaseUrl: origin, sessionId: "session-test" };
const user = { userId: "u1", displayName: "测试账号", tenantName: "测试企业" };
const token = { token: "gateway-new", expiredAt: "2099-01-01T00:00:00Z" };
const model = {
  modelSource: "preset",
  modelCategory: "ITT",
  modelName: "测试模型",
  modelID: "model-mm",
  apiName: "model-mm",
  apiProtocol: "openai",
  url: chatUrl,
  accessStatus: "Running",
  maxOutputTokens: 96000,
  modelDescription: "支持图片",
};
function snapshot(extra = {}): ResourceSnapshot {
  return {
    id: "r1",
    type: "dumate-account",
    key: "dumate:test",
    state: { status: "ready" },
    privateData: {
      ...credential,
      ...user,
      accessToken: "gateway-old",
      expiresAtMs: Date.parse(token.expiredAt),
      ...extra,
    },
  };
}
function request(): LlmRequest {
  return {
    instructions: "简短回答",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "你好" },
        { type: "image", mediaType: "image/png", dataBase64: "aW1hZ2U=" },
      ],
    }],
    tools: [{ name: "weather", description: "查询天气", parameters: { type: "object" } }],
    reasoning: { enabled: true, effort: "high" },
    latency: "fast",
    maxOutputTokens: 256,
    cacheKey: "cache",
  };
}
function response(status: number, data: unknown) {
  return { status, headers: {}, body: JSON.stringify(data) };
}
function stream(status: number, data: unknown[]): NetworkEventStream {
  return {
    status,
    headers: {},
    lines: (async function* () {
      for (const d of data) yield typeof d === "string" ? d : `data: ${JSON.stringify(d)}`;
    })(),
  };
}
function context(handlers: {
  fetch?: (url: string, init?: NetworkRequestInit) => ReturnType<typeof response>;
  stream?: (url: string, init?: NetworkRequestInit) => NetworkEventStream;
}): PluginContext {
  return {
    signal: new AbortController().signal,
    network: {
      fetch: async (url, init) => {
        if (!handlers.fetch) throw new Error("不应请求 fetch");
        return handlers.fetch(url, init);
      },
      stream: async (url, init) => {
        if (!handlers.stream) throw new Error("不应请求 stream");
        return handlers.stream(url, init);
      },
    },
  };
}

Deno.test("导入当前会话时联网验证账号，租户参与去重，展示不含凭证", async () => {
  const { credentialImport, presentAccount } = await import("./resources.ts");
  const result = await credentialImport.parse(
    [{ name: "dumate.json", content: JSON.stringify(credential) }],
    context({
      fetch: (url, init) => {
        equal(url, `${origin}/api/dumate-enterprise/app/v1/user`);
        equal(init?.headers?.cookie, "dumate_enterprise_sessionid=session-test");
        return response(200, user);
      },
    }),
  );
  equal(result.resources[0].key, `dumate:${origin}:u1`);
  const view = presentAccount({ ...snapshot(), privateData: result.resources[0].privateData });
  equal(view.displayName, "测试账号");
  assert(!JSON.stringify(view).includes("session-test"));
});

Deno.test("导入拒绝无效会话及不可信的企业地址", async () => {
  const { credentialImport } = await import("./resources.ts");
  for (
    const apiBaseUrl of [
      "http://zhongzhi.dumate.cn",
      "https://evil.example",
      `${origin}/path`,
      `https://u:p@zhongzhi.dumate.cn`,
    ]
  ) {
    await rejects(
      () =>
        credentialImport.parse([{
          name: "bad.json",
          content: JSON.stringify({ ...credential, apiBaseUrl }),
        }], context({})),
      "企业地址",
    );
  }
  await rejects(
    () =>
      credentialImport.parse([{
        name: "bad.json",
        content: JSON.stringify({ ...credential, sessionId: "bad; injected=1" }),
      }], context({})),
    "会话",
  );
  await rejects(
    () =>
      credentialImport.parse(
        [{ name: "expired.json", content: JSON.stringify(credential) }],
        context({ fetch: () => response(401, {}) }),
      ),
    "401",
  );
});

Deno.test("按真实目录字段同步模型，跳过非预置及未运行模型", async () => {
  const { dumateModels } = await import("./models.ts");
  const models = await dumateModels.list(
    { resource: snapshot() },
    context({
      fetch: (url, init) => {
        equal(url, `${origin}/api/dumate-enterprise/app/v1/model/list-all`);
        equal(init?.method, "POST");
        equal(init?.headers?.cookie, "dumate_enterprise_sessionid=session-test");
        return response(200, {
          items: [model, { ...model, modelID: "custom", modelSource: "custom" }, {
            ...model,
            accessStatus: "Stopped",
          }],
          totalCount: 3,
        });
      },
    }),
  );
  equal(models, [{
    id: "model-mm",
    displayName: "测试模型",
    description: "支持图片",
    maxOutputTokens: 96000,
    capabilities: { images: true },
    privateData: { url: chatUrl },
  }]);
});

Deno.test("目录错误及不可信模型地址直接报错，不使用静态回退", async () => {
  const { dumateModels } = await import("./models.ts");
  await rejects(
    () => dumateModels.list({ resource: snapshot() }, context({ fetch: () => response(503, {}) })),
    "503",
  );
  await rejects(
    () =>
      dumateModels.list(
        { resource: snapshot() },
        context({ fetch: () => response(200, { message: "bad" }) }),
      ),
    "模型目录",
  );
  await rejects(
    () =>
      dumateModels.list(
        { resource: snapshot() },
        context({
          fetch: () => response(200, { items: [{ ...model, url: "https://evil.example/chat" }] }),
        }),
      ),
    "网关地址",
  );
});

Deno.test("令牌临期先续取，流式转换思考、正文和工具参数并保存新令牌", async () => {
  const { dumateProvider } = await import("./provider.ts");
  const events: ModelEvent[] = [];
  const result = await dumateProvider.invoke(
    {
      model: { id: "model-mm", displayName: "测试模型", privateData: { url: chatUrl } },
      resource: snapshot({ expiresAtMs: 0 }),
      request: request(),
    },
    { emit: (e) => events.push(e) },
    context({
      fetch: (url, init) => {
        equal(url, `${origin}/api/dumate-enterprise/app/v1/user_token`);
        equal(init?.headers?.cookie, "dumate_enterprise_sessionid=session-test");
        return response(200, token);
      },
      stream: (url, init) => {
        equal(url, chatUrl);
        equal(init?.headers?.authorization, "Bearer gateway-new");
        equal(init?.headers?.["x-dumate-prd-source"], "enterprise");
        assert(!JSON.stringify(init?.headers).includes("session-test"));
        const body = JSON.parse(init!.body!);
        equal(body.model, "model-mm");
        equal(body.max_completion_tokens, 256);
        equal(body.reasoning_effort, undefined);
        equal(body.service_tier, undefined);
        equal(body.prompt_cache_key, undefined);
        equal(body.tools[0].function.name, "weather");
        equal(body.messages[1].content[1].image_url.url, "data:image/png;base64,aW1hZ2U=");
        return stream(200, [
          { choices: [{ delta: { reasoning_content: "思考" } }] },
          { choices: [{ delta: { content: "你好" } }] },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call1",
                  function: { name: "weather", arguments: '{"city":' },
                }],
              },
            }],
          },
          {
            choices: [{
              delta: { tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }] },
              finish_reason: "tool_calls",
            }],
            usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
          },
          "data: [DONE]",
        ]);
      },
    }),
  );
  equal(result.status, "completed");
  equal((result.patch?.privateData as Record<string, unknown>).accessToken, "gateway-new");
  assert(events.some((e) => e.type === "thinking-delta" && e.text === "思考"));
  assert(events.some((e) => e.type === "text-delta" && e.text === "你好"));
  assert(events.some((e) => e.type === "tool-call-start" && e.callId === "call1"));
  equal(events.at(-1), { type: "done", reason: "tool-use" });
});

Deno.test("网关 401 只续取重试一次，完成后持久化", async () => {
  const { dumateProvider } = await import("./provider.ts");
  let calls = 0, refreshes = 0;
  const result = await dumateProvider.invoke(
    {
      model: { id: "m", displayName: "m", privateData: { url: chatUrl } },
      resource: snapshot(),
      request: request(),
    },
    { emit: () => {} },
    context({
      fetch: () => {
        refreshes++;
        return response(200, token);
      },
      stream: () =>
        ++calls === 1 ? stream(401, ['{"error":"expired"}']) : stream(200, [
          { choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] },
          "data: [DONE]",
        ]),
    }),
  );
  equal(calls, 2);
  equal(refreshes, 1);
  equal(result.status, "completed");
  equal((result.patch?.privateData as Record<string, unknown>).accessToken, "gateway-new");
});

Deno.test("会话失效标记无效，限流冷却，服务端错误不损坏账号", async () => {
  const { dumateProvider } = await import("./provider.ts");
  const input = {
    model: { id: "m", displayName: "m", privateData: { url: chatUrl } },
    resource: snapshot(),
    request: request(),
  };
  const expired = await dumateProvider.invoke(
    { ...input, resource: snapshot({ expiresAtMs: 0 }) },
    { emit: () => {} },
    context({ fetch: () => response(401, {}) }),
  );
  equal(expired.status, "resource-error");
  equal(expired.patch?.state?.status, "invalid");
  const limited = await dumateProvider.invoke(
    input,
    { emit: () => {} },
    context({ stream: () => stream(429, ["limited"]) }),
  );
  equal(limited.status, "resource-error");
  equal(limited.patch?.state?.status, "cooling");
  const failed = await dumateProvider.invoke(
    input,
    { emit: () => {} },
    context({ stream: () => stream(500, ["upstream failed"]) }),
  );
  equal(failed.status, "request-error");
});

Deno.test("流中途失败不得重试，避免重复输出", async () => {
  const { dumateProvider } = await import("./provider.ts");
  let calls = 0;
  const result = await dumateProvider.invoke(
    {
      model: { id: "m", displayName: "m", privateData: { url: chatUrl } },
      resource: snapshot(),
      request: request(),
    },
    { emit: () => {} },
    context({
      stream: () => {
        calls++;
        return stream(200, [{ choices: [{ delta: { content: "部分内容" } }] }, {
          error: { message: "stream failed" },
        }]);
      },
    }),
  );
  equal(calls, 1);
  equal(result.status, "request-error");
});

Deno.test("手动刷新账号会持久化令牌并恢复就绪状态", async () => {
  const { refreshAccount } = await import("./resources.ts");
  const patch = await refreshAccount(snapshot(), context({ fetch: () => response(200, token) }));
  equal(patch.state?.status, "ready");
  equal((patch.privateData as Record<string, unknown>).accessToken, "gateway-new");
});

Deno.test("控制台未返回有效令牌时保留错误，不继续调用网关", async () => {
  const { dumateProvider } = await import("./provider.ts");
  for (
    const data of [{ expiredAt: token.expiredAt }, { token: "invalid", expiredAt: "invalid-date" }]
  ) {
    const result = await dumateProvider.invoke(
      {
        model: { id: "m", displayName: "m", privateData: { url: chatUrl } },
        resource: snapshot({ accessToken: null, expiresAtMs: null }),
        request: request(),
      },
      { emit: () => {} },
      context({ fetch: () => response(200, data) }),
    );
    equal(result.status, "request-error");
  }
});

Deno.test("网关重试后仍未授权时停止，不循环续取", async () => {
  const { dumateProvider } = await import("./provider.ts");
  let calls = 0, refreshes = 0;
  const result = await dumateProvider.invoke(
    {
      model: { id: "m", displayName: "m", privateData: { url: chatUrl } },
      resource: snapshot(),
      request: request(),
    },
    { emit: () => {} },
    context({
      fetch: () => {
        refreshes++;
        return response(200, token);
      },
      stream: () => {
        calls++;
        return stream(401, ["unauthorized"]);
      },
    }),
  );
  equal(calls, 2);
  equal(refreshes, 1);
  equal(result.status, "resource-error");
  equal(result.patch?.state?.status, "invalid");
});

Deno.test("添加入口声明本机读取，不再让用户选择凭证文件", async () => {
  const { credentialImport } = await import("./resources.ts");
  const metadata = credentialImport as unknown as Record<string, unknown>;
  equal(metadata.localSource, "dumate");
  equal(metadata.accept, []);
  assert(!JSON.stringify(metadata.description).includes("export-session"));
});
