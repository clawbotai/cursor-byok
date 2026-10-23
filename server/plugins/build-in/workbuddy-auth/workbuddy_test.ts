import type {
  JsonValue,
  NetworkEventStream,
  NetworkResponse,
  PluginContext,
} from "cursor-byok:plugin";
import type { LlmRequest, ModelEvent } from "cursor-byok:provider";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { workbuddyOAuth } from "./oauth.ts";
import { FALLBACK_MODELS, parseWorkBuddyModels, workbuddyModels } from "./models.ts";
import { isQuotaError, workbuddyProvider } from "./provider.ts";
import {
  credentialDraft,
  parseBillingSummary,
  presentAccount,
  quotaState,
  refreshAccount,
  RESOURCE_TYPE,
} from "./resources.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, received ${left}`);
}

type RequestInit = { body?: string; headers?: Record<string, string> };
type FetchHandler = (url: string, init?: RequestInit) => NetworkResponse;
type StreamHandler = (url: string, init?: RequestInit) => NetworkEventStream;

function context(handlers: { fetch?: FetchHandler; stream?: StreamHandler }): PluginContext {
  return {
    network: {
      fetch: (url, init) => {
        if (!handlers.fetch) throw new Error("fetch was not expected");
        return Promise.resolve(handlers.fetch(url, init));
      },
      stream: (url, init) => {
        if (!handlers.stream) throw new Error("stream was not expected");
        return Promise.resolve(handlers.stream(url, init));
      },
    },
    signal: new AbortController().signal,
  };
}

function jsonResponse(status: number, body: unknown): NetworkResponse {
  return { status, headers: {}, body: JSON.stringify(body) };
}

function sse(chunks: string[]): NetworkEventStream {
  async function* lines(): AsyncIterable<string> {
    for (const chunk of chunks) yield chunk;
  }
  return { status: 200, headers: {}, lines: lines() };
}

function snapshot(privateData: JsonValue): ResourceSnapshot {
  return { id: "r1", type: RESOURCE_TYPE, key: "k1", privateData, state: { status: "ready" } };
}

function account(overrides: Record<string, unknown> = {}): JsonValue {
  return {
    accessToken: "token-a",
    refreshToken: "refresh-a",
    uid: "uid-1",
    displayName: "昵称",
    domain: "www.codebuddy.cn",
    expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
    refreshExpiresAtMs: Date.now() + 48 * 60 * 60 * 1000,
    quota: null,
    ...overrides,
  } as unknown as JsonValue;
}

function request(): LlmRequest {
  return {
    instructions: "",
    messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
    tools: [],
    reasoning: { enabled: false, effort: null },
    latency: "standard",
    maxOutputTokens: null,
    cacheKey: null,
  };
}

Deno.test("credential draft keys by uid and keeps tokens private-side", async () => {
  const draft = await credentialDraft({
    accessToken: "token-a",
    refreshToken: "refresh-a",
    uid: "uid-1",
    displayName: "昵称",
    expiresIn: 2419200,
    refreshExpiresIn: 2592000,
  });
  assertEquals(draft.key, "workbuddy:uid-1");
  const data = draft.privateData as Record<string, unknown>;
  assertEquals(data.accessToken, "token-a");
  assertEquals(data.expiresAtMs !== null, true);
});

Deno.test("billing summary aggregates package capacities into remaining credits", () => {
  const quota = parseBillingSummary({
    IsPaidUser: true,
    Packages: [
      {
        PackageCode: "free",
        CycleTotalCapacity: "1000",
        CycleRemainCapacity: "400.5",
        CycleUsedCapacity: "599.5",
        CapacityUnit: "credits",
      },
      {
        PackageCode: "pro",
        CycleTotalCapacity: 2000,
        CycleRemainCapacity: 1000,
        CycleUsedCapacity: 1000,
        CapacityUnit: "credits",
      },
    ],
  });
  assertEquals(quota.totalCredits, 3000);
  assertEquals(quota.remainingCredits, 1400.5);
  assertEquals(quota.isPaidUser, true);
  assertEquals(quotaState(quota).status, "ready");

  const exhausted = parseBillingSummary({
    Packages: [{ CycleTotalCapacity: 10, CycleRemainCapacity: 0, CycleUsedCapacity: 10 }],
  });
  assertEquals(quotaState(exhausted).status, "cooling");
});

Deno.test("present shows nickname and remaining credits metric", async () => {
  const draft = await credentialDraft({
    accessToken: "token-a",
    refreshToken: "refresh-a",
    uid: "uid-1",
    displayName: "昵称",
  });
  let view = presentAccount(snapshot(draft.privateData));
  assertEquals(view.displayName, "昵称");
  assertEquals(view.metrics, undefined);

  view = presentAccount(
    snapshot(account({ quota: { remainingCredits: 12, totalCredits: 100, isPaidUser: true } })),
  );
  assertEquals(view.metrics?.[0].value, 12);
  assertEquals(view.description, { "en-US": "Paid plan", "zh-CN": "付费版" });
});

Deno.test("model discovery parses the enterprise model matrix and skips image generators", () => {
  const models = parseWorkBuddyModels({
    models: [
      { id: "fast-model", name: "快速", maxOutputTokens: 48000, supportsImages: true },
      { id: "hunyuan-image-v3.0" },
      { id: "kimi-k2.7", maxInputTokens: 200000 },
      { id: "kimi-k2.7" },
    ],
  });
  assertEquals(models.length, 2);
  assertEquals(models[0].id, "fast-model");
  assertEquals(models[0].displayName, "快速");
  assertEquals(models[0].capabilities, { images: true });
  assertEquals(models[0].maxOutputTokens, 48000);
  assertEquals(models[1].displayName, "Kimi K2.7");
});

Deno.test("model discovery falls back to the known list when the account cannot list", async () => {
  const models = await workbuddyModels.list(
    { resource: snapshot(account()) },
    context({
      fetch: () => jsonResponse(403, { code: 403, msg: "forbidden" }),
    }),
  );
  assertEquals(models, FALLBACK_MODELS);
});

Deno.test("web OAuth begins with an authorization URL and completes with a resource draft", async () => {
  const began = await workbuddyOAuth.begin(context({
    fetch: (url) => {
      assertEquals(
        url,
        "https://copilot.tencent.com/v2/plugin/auth/state?platform=console",
      );
      return jsonResponse(200, {
        code: 0,
        msg: "ok",
        data: {
          state: "state-1",
          authUrl: "https://www.workbuddy.cn/login/wecom-auth?state=state-1",
        },
      });
    },
  }));
  assertEquals(began.userCode, "");
  assertEquals(began.verificationUrl, "https://www.workbuddy.cn/login/wecom-auth?state=state-1");
  assertEquals(began.pollIntervalMs, 2000);

  let polls = 0;
  const pending = await workbuddyOAuth.poll(
    began.session,
    context({
      fetch: (url, init) => {
        assert(url.startsWith("https://copilot.tencent.com/v2/plugin/auth/token?state=state-1"));
        polls += 1;
        assertEquals(init?.headers?.["x-no-authorization"], "true");
        return jsonResponse(200, { code: 1004, msg: "waiting" });
      },
    }),
  );
  assertEquals(polls, 1);
  assertEquals(pending.status, "pending");

  // 授权完成后:轮询接口给令牌,再取账号资料产出资源。
  const done = await workbuddyOAuth.poll(
    began.session,
    context({
      fetch: (url) => {
        if (url === "https://copilot.tencent.com/v2/plugin/account") {
          return jsonResponse(200, {
            code: 0,
            msg: "ok",
            data: { uid: "uid-9", nickname: "小程序昵称" },
          });
        }
        return jsonResponse(200, {
          code: 0,
          msg: "ok",
          data: {
            auth: {
              accessToken: "token-new",
              refreshToken: "refresh-new",
              expiresIn: 2419200,
              refreshExpiresIn: 2592000,
              domain: "www.codebuddy.cn",
            },
          },
        });
      },
    }),
  );
  assertEquals(done.status, "completed");
  if (done.status !== "completed") throw new Error("unreachable");
  assertEquals(done.resources.length, 1);
  assertEquals(done.resources[0].key, "workbuddy:uid-9");
  const data = done.resources[0].privateData as Record<string, unknown>;
  assertEquals(data.accessToken, "token-new");
  assertEquals(data.displayName, "小程序昵称");
});

Deno.test("invoke streams normalized events from the WorkBuddy chat endpoint", async () => {
  const events: ModelEvent[] = [];
  let streamUrl = "";
  let streamHeaders: Record<string, string> = {};
  const result = await workbuddyProvider.invoke(
    {
      model: { id: "fast-model", displayName: "Fast" },
      resource: snapshot(account()),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: (url, init) => {
        streamUrl = url;
        streamHeaders = init?.headers ?? {};
        return sse([
          'data: {"choices":[{"delta":{"content":"你好"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
          "data: [DONE]",
        ]);
      },
    }),
  );
  assertEquals(result.status, "completed");
  assertEquals(streamUrl, "https://copilot.tencent.com/v2/chat/completions");
  assertEquals(streamHeaders.authorization, "Bearer token-a");
  assertEquals(streamHeaders["x-user-id"], "uid-1");
  assertEquals(streamHeaders["x-domain"], "www.codebuddy.cn");
  assertEquals(streamHeaders["user-agent"], "CLI/2.63.2 CodeBuddy/2.63.2");
  assert(events.some((event) => event.type === "text-delta"));
  assert(events.at(-1)?.type === "done");
});

Deno.test("invoke refreshes the token once on 401 and persists the new token", async () => {
  const events: ModelEvent[] = [];
  let streams = 0;
  const result = await workbuddyProvider.invoke(
    {
      model: { id: "fast-model", displayName: "Fast" },
      resource: snapshot(account()),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      fetch: (url, init) => {
        assertEquals(url, "https://copilot.tencent.com/v2/plugin/auth/token/refresh");
        assertEquals(init?.headers?.["x-refresh-token"], "refresh-a");
        assertEquals(init?.headers?.["x-auth-refresh-source"], "plugin");
        return jsonResponse(200, {
          code: 0,
          msg: "ok",
          data: {
            accessToken: "token-b",
            refreshToken: "refresh-b",
            expiresIn: 2419200,
            domain: "www.codebuddy.cn",
          },
        });
      },
      stream: () => {
        streams += 1;
        if (streams === 1) {
          return {
            status: 401,
            headers: {},
            lines: (async function* () {
              yield "unauthorized";
            })(),
          };
        }
        return sse([
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
          "data: [DONE]",
        ]);
      },
    }),
  );
  assertEquals(result.status, "completed");
  assertEquals(streams, 2);
  if (result.status !== "completed") throw new Error("unreachable");
  const patchData = result.patch?.privateData as Record<string, unknown>;
  assertEquals(patchData.accessToken, "token-b");
});

Deno.test("invoke maps quota failures to a cooling resource error", async () => {
  const result = await workbuddyProvider.invoke(
    {
      model: { id: "fast-model", displayName: "Fast" },
      resource: snapshot(account()),
      request: request(),
    },
    { emit: () => {} },
    context({
      stream: () => ({
        status: 429,
        headers: {},
        lines: (async function* () {
          yield '{"code":6004,"msg":"rate limited"}';
        })(),
      }),
    }),
  );
  assertEquals(result.status, "resource-error");
  assert(result.patch?.state?.status === "cooling");
});

Deno.test("quota keywords classify stream errors", () => {
  assert(isQuotaError("credits exhausted"));
  assert(isQuotaError("code 6004 limited"));
  assert(!isQuotaError("bad request"));
});

Deno.test("refresh hook updates quota and downgrades to invalid when authorization fails", async () => {
  const patch = await refreshAccount(
    snapshot(account()),
    context({
      fetch: (url) => {
        assertEquals(url, "https://copilot.tencent.com/billing/meter/get-user-resource-summary");
        return jsonResponse(200, {
          code: 0,
          msg: "ok",
          data: {
            IsPaidUser: false,
            Packages: [{
              CycleTotalCapacity: "500",
              CycleRemainCapacity: "120",
              CycleUsedCapacity: "380",
            }],
          },
        });
      },
    }),
  );
  assertEquals(patch.state?.status, "ready");
  const quota = (patch.privateData as Record<string, unknown>).quota as Record<string, unknown>;
  assertEquals(quota.remainingCredits, 120);
  assertEquals(quota.totalCredits, 500);
  assertEquals(quota.isPaidUser, false);

  const invalid = await refreshAccount(
    snapshot(account()),
    context({
      fetch: () => jsonResponse(401, { code: 401, msg: "unauthorized" }),
    }),
  );
  assertEquals(invalid.state?.status, "invalid");
});
