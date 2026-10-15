import type {
  JsonValue,
  NetworkEventStream,
  NetworkResponse,
  PluginContext,
} from "cursor-byok:plugin";
import type { LlmRequest, ModelEvent } from "cursor-byok:provider";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { antigravityProvider, isQuotaError } from "./provider.ts";
import { RESOURCE_TYPE } from "./resources.ts";

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

function snapshot(privateData: JsonValue): ResourceSnapshot {
  return {
    id: "resource-1",
    type: RESOURCE_TYPE,
    key: "antigravity:user-1",
    privateData,
    state: { status: "ready" },
  };
}

async function* sse(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

function request(): LlmRequest {
  return {
    instructions: "You are an AI coding assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    reasoning: { enabled: true, effort: "medium" },
    latency: "standard",
    maxOutputTokens: 65536,
    cacheKey: "conv-1",
  };
}

Deno.test("provider parses usage metadata including cachedContentTokenCount as cacheReadTokens", async () => {
  let requestBody = "";
  let requestHeaders: Record<string, string> = {};
  const events: ModelEvent[] = [];

  const result = await antigravityProvider.invoke(
    {
      model: {
        id: "gemini-3.7-flash-medium",
        displayName: "Gemini 3.7 Flash Medium",
        privateData: {},
      },
      resource: snapshot({
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresAt: Date.now() + 3600_000,
        projectId: "test-project-123",
      }),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: (url, init) => {
        assert(url.includes("/v1internal:streamGenerateContent?alt=sse"));
        requestBody = init?.body ?? "";
        requestHeaders = init?.headers ?? {};
        return {
          status: 200,
          headers: {},
          lines: sse([
            'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"Thinking..."}]}}]}}',
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello world"}]}}]}}',
            'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":15,"totalTokenCount":135,"cachedContentTokenCount":80}}}',
          ]),
        };
      },
    }),
  );

  assertEquals(result, { status: "completed" });
  assertEquals(requestHeaders["authorization"], "Bearer mock-access-token");
  assertEquals(requestHeaders.accept, "text/event-stream");
  assert(!("session-id" in requestHeaders), "Codex-only session-id header was sent");
  assert(!("thread-id" in requestHeaders), "Codex-only thread-id header was sent");
  assert(!("x-client-request-id" in requestHeaders), "request-id header was reused as cache key");
  const body = JSON.parse(requestBody) as Record<string, unknown>;
  assertEquals(body.project, "test-project-123");
  assertEquals(body.model, "gemini-3.7-flash-medium");
  assert(!("sessionId" in body), "unsupported sessionId field was sent");
  assert(!("conversationId" in body), "unsupported conversationId field was sent");

  assertEquals(events, [
    { type: "thinking-start" },
    { type: "thinking-delta", text: "Thinking..." },
    { type: "thinking-end" },
    { type: "text-start" },
    { type: "text-delta", text: "Hello world" },
    { type: "text-end" },
    {
      type: "usage",
      usage: {
        inputTokens: 120,
        outputTokens: 15,
        totalTokens: 135,
        cacheReadTokens: 80,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    },
    { type: "done", reason: "stop" },
  ]);
});

Deno.test("isQuotaError identifies rate limits and quota exhaustion", () => {
  assert(isQuotaError("RESOURCE_EXHAUSTED: quota exceeded"));
  assert(isQuotaError("Rate limit exceeded for model"));
  assert(isQuotaError("HTTP 429 Too Many Requests"));
  assert(!isQuotaError("Invalid authorization header"));
});

Deno.test("Antigravity forwards the caller output budget instead of reserving 65536 tokens", async () => {
  let budget: unknown;
  const input = request();
  input.maxOutputTokens = 1024;
  const result = await antigravityProvider.invoke({
    model: { id: "gemini-3.8-flash-high", displayName: "Gemini 3.8", privateData: {} },
    resource: snapshot({ accessToken: "test", refreshToken: null, expiresAtMs: Date.now() + 3600000, projectId: "test-project" }),
    request: input,
  }, { emit() {} }, context({ stream: (_url, init) => {
    budget = JSON.parse(init!.body!).request.generationConfig.maxOutputTokens;
    return { status: 200, headers: {}, lines: sse(['data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}']) };
  } }));
  assertEquals(result.status, "completed");
  assertEquals(budget, 1024);
});

Deno.test("Antigravity preserves tool property names that also name schema keywords", async () => {
  let parameters: any;
  const input = request();
  input.tools = [{ name: "workflow", description: "Declare phases", parameters: {
    type: "object", properties: { phases: { type: "array", items: {
      type: "object", properties: { title: { type: "string", title: "Phase title" }, type: { type: "string" } }, required: ["title"],
    } } },
  } }];
  await antigravityProvider.invoke({
    model: { id: "gemini-3.8-flash-high", displayName: "Gemini 3.8", privateData: {} },
    resource: snapshot({ accessToken: "test", expiresAtMs: Date.now() + 3600000, projectId: "test-project" }),
    request: input,
  }, { emit() {} }, context({ stream: (_url, init) => {
    parameters = JSON.parse(init!.body!).request.tools[0].functionDeclarations[0].parameters;
    return { status: 200, headers: {}, lines: sse(['data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}']) };
  } }));
  assertEquals(parameters.properties.phases.items.properties.title, { type: "STRING" });
  assertEquals(parameters.properties.phases.items.properties.type, { type: "STRING" });
  assertEquals(parameters.properties.phases.items.required, ["title"]);
});

for (const status of [400, 401, 403, 429]) {
  Deno.test(`Antigravity preserves HTTP ${status} without trying other endpoints`, async () => {
    const urls: string[] = [];
    const result = await antigravityProvider.invoke({
      model: { id: "gemini-3.8-flash-high", displayName: "Gemini", privateData: {} },
      resource: snapshot({ accessToken: "test", refreshToken: null, projectId: "project" }),
      request: request(),
    }, { emit() {} }, context({ stream: (url) => {
      urls.push(url);
      if (urls.length > 1) throw new Error("connection failed on fallback");
      return { status, headers: {}, lines: sse(['{"error":{"message":"location rejected"}}']) };
    } }));
    assertEquals(urls.length, 1);
    assert(result.status !== "completed");
    assert(result.message.includes(`HTTP ${status}:`), result.message);
    assert(result.message.includes("location rejected"), result.message);
    assert(result.message.includes("daily-cloudcode-pa.googleapis.com"), result.message);
  });
}

Deno.test("Antigravity tries the next endpoint on transient server errors", async () => {
  const urls: string[] = [];
  const result = await antigravityProvider.invoke({
    model: { id: "gemini-3.8-flash-high", displayName: "Gemini", privateData: {} },
    resource: snapshot({ accessToken: "test", projectId: "project" }),
    request: request(),
  }, { emit() {} }, context({ stream: (url) => {
    urls.push(url);
    return urls.length === 1
      ? { status: 503, headers: {}, lines: sse(['{"error":{"message":"busy"}}']) }
      : { status: 200, headers: {}, lines: sse(['data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}']) };
  } }));
  assertEquals(result.status, "completed");
  assertEquals(urls.length, 2);
});

Deno.test("Antigravity refreshes expired credentials without querying quota before generation", async () => {
  const urls: string[] = [];
  let authorization: string | undefined;
  const result = await antigravityProvider.invoke({
    model: { id: "gemini-3.8-flash-high", displayName: "Gemini", privateData: {} },
    resource: snapshot({ accessToken: "expired", refreshToken: "refresh", expiresAtMs: 1, projectId: "existing-project" }),
    request: request(),
  }, { emit() {} }, context({
    fetch: (url) => {
      urls.push(url);
      if (url !== "https://oauth2.googleapis.com/token") throw new Error("quota must not block generation");
      return { status: 200, headers: {}, body: JSON.stringify({ access_token: "fresh", expires_in: 3600 }) };
    },
    stream: (_url, init) => {
      authorization = init?.headers?.authorization;
      assertEquals(JSON.parse(init!.body!).project, "existing-project");
      return { status: 200, headers: {}, lines: sse(['data: {"response":{"candidates":[{"finishReason":"STOP"}]}}']) };
    },
  }));
  assertEquals(result.status, "completed");
  assertEquals(authorization, "Bearer fresh");
  assertEquals(urls, ["https://oauth2.googleapis.com/token"]);
  assertEquals((result.patch?.privateData as Record<string, unknown>).accessToken, "fresh");
});

Deno.test("Antigravity stops on revoked credentials instead of sending the expired token", async () => {
  let streams = 0;
  const result = await antigravityProvider.invoke({
    model: { id: "gemini-3.8-flash-high", displayName: "Gemini", privateData: {} },
    resource: snapshot({ accessToken: "expired", refreshToken: "revoked", expiresAtMs: 1 }),
    request: request(),
  }, { emit() {} }, context({
    fetch: () => ({ status: 400, headers: {}, body: '{"error":"invalid_grant"}' }),
    stream: () => { streams++; throw new Error("expired token must not be sent"); },
  }));
  assertEquals(result.status, "resource-error");
  assertEquals(result.patch?.state?.status, "invalid");
  assertEquals(streams, 0);
});

Deno.test("Antigravity does not report a truncated stream as completed or replay partial output", async () => {
  let streams = 0;
  const events: ModelEvent[] = [];
  const result = await antigravityProvider.invoke({
    model: { id: "gemini-3.8-flash-high", displayName: "Gemini", privateData: {} },
    resource: snapshot({ accessToken: "test", projectId: "project" }),
    request: request(),
  }, { emit: (event) => events.push(event) }, context({ stream: () => {
    streams++;
    return { status: 200, headers: {}, lines: sse(['data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}']) };
  } }));
  assertEquals(result.status, "request-error");
  assertEquals(streams, 1);
  assert(!events.some((event) => event.type === "done"));
});

Deno.test("Antigravity retains a refreshed token when generation is rejected", async () => {
  const result = await antigravityProvider.invoke({
    model: { id: "gemini-3.8-flash-high", displayName: "Gemini", privateData: {} },
    resource: snapshot({ accessToken: "expired", refreshToken: "refresh", expiresAtMs: 1, projectId: "project" }),
    request: request(),
  }, { emit() {} }, context({
    fetch: () => ({ status: 200, headers: {}, body: '{"access_token":"fresh","expires_in":3600}' }),
    stream: () => ({ status: 400, headers: {}, lines: sse(['location rejected']) }),
  }));
  assertEquals(result.status, "request-error");
  assertEquals((result.patch?.privateData as Record<string, unknown>)?.accessToken, "fresh");
});

Deno.test("Antigravity refreshes once after HTTP 401 and retries with the fresh token", async () => {
  const authorizations: unknown[] = [];
  const fetches: string[] = [];
  const result = await antigravityProvider.invoke({
    model: { id: "gemini-3.8-flash-high", displayName: "Gemini", privateData: {} },
    resource: snapshot({ accessToken: "old", refreshToken: "refresh", expiresAtMs: Date.now() + 3600_000, projectId: "project" }),
    request: request(),
  }, { emit() {} }, context({
    fetch: (url) => {
      fetches.push(url);
      return { status: 200, headers: {}, body: '{"access_token":"fresh","expires_in":3600}' };
    },
    stream: (_url, init) => {
      authorizations.push(init?.headers?.authorization);
      return authorizations.length === 1
        ? { status: 401, headers: {}, lines: sse(['expired']) }
        : { status: 200, headers: {}, lines: sse(['data: {"response":{"candidates":[{"finishReason":"STOP"}]}}']) };
    },
  }));
  assertEquals(result.status, "completed");
  assertEquals(authorizations, ["Bearer old", "Bearer fresh"]);
  assertEquals(fetches, ["https://oauth2.googleapis.com/token"]);
});

Deno.test("Antigravity stops when token refresh fails instead of using expired credentials", async () => {
  let streams = 0;
  const result = await antigravityProvider.invoke({
    model: { id: "gemini-3.8-flash-high", displayName: "Gemini", privateData: {} },
    resource: snapshot({ accessToken: "expired", refreshToken: "refresh", expiresAtMs: 1 }),
    request: request(),
  }, { emit() {} }, context({
    fetch: () => ({ status: 503, headers: {}, body: 'token endpoint unavailable' }),
    stream: () => { streams++; throw new Error("expired token must not be sent"); },
  }));
  assert(result.status === "request-error");
  assert(result.message.includes("HTTP 503: token endpoint unavailable"));
  assertEquals(streams, 0);
});

Deno.test("Antigravity reports an exhausted output budget as length instead of a normal stop", async () => {
  const events: ModelEvent[] = [];
  await antigravityProvider.invoke({
    model: { id: "gemini-3.8-flash-high", displayName: "Gemini", privateData: {} },
    resource: snapshot({ accessToken: "test", projectId: "project" }),
    request: request(),
  }, { emit: (event) => events.push(event) }, context({ stream: () => ({
    status: 200, headers: {}, lines: sse(['data: {"response":{"candidates":[{"finishReason":"MAX_TOKENS"}]}}']),
  }) }));
  assertEquals(events, [{ type: "done", reason: "length" }]);
});
