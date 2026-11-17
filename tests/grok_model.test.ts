import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildGrokRequest,
  clearImageDataUrlCache,
  extractJsonObject,
  extractStreamedText,
  grokAuthStatus,
  imageDataUrlCacheSize,
  imageToDataUrl,
  isCreditLimitError,
  isRetryableStatus,
  isTransportFailure,
  normalizeModelText,
  resetGrokCredentialState,
  runGrokProcess,
} from "../grok_model";

const originalFetch = globalThis.fetch;

const originalGrokHome = process.env.GROK_HOME;

function restoreEnv() {
  delete process.env.BILI_GROK_API_KEY;
  delete process.env.XAI_API_KEY;
  if (originalGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = originalGrokHome;
  globalThis.fetch = originalFetch;
  resetGrokCredentialState();
}

afterEach(restoreEnv);

describe("runGrokProcess", () => {
  test("missing key throws", async () => {
    restoreEnv();
    const emptyHome = mkdtempSync(join(tmpdir(), "no-grok-home-"));
    process.env.GROK_HOME = emptyHome;
    try {
      await expect(runGrokProcess({
        prompt: "生成标题",
        model: "grok-4.6",
        cwd: "/tmp",
        timeoutMs: 1000,
      })).rejects.toThrow("缺少 Grok 凭证");
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  test("successful JSON is written to outputFile", async () => {
    process.env.BILI_GROK_API_KEY = "test-grok-key";
    const dir = mkdtempSync(join(tmpdir(), "grok-out-"));
    const outputFile = join(dir, "reply.json");
    const schemaFile = join(dir, "schema.json");
    writeFileSync(schemaFile, JSON.stringify({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    }));
    let captured: { url?: string; body?: any; headers?: Headers } = {};
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(input),
        body: JSON.parse(String(init?.body || "{}")),
        headers: new Headers(init?.headers),
      };
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"title":"蒙古派对闯入一匹马"}' }, finish_reason: "stop" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const result = await runGrokProcess({
        prompt: "只输出JSON",
        model: "grok-4.6",
        cwd: dir,
        timeoutMs: 5000,
        outputSchema: schemaFile,
        outputFile,
      });
      expect(result.code).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(readFileSync(outputFile, "utf-8")).toContain("蒙古派对闯入一匹马");
      expect(captured.url).toBe("https://api.x.ai/v1/chat/completions");
      expect(captured.headers?.get("Authorization")).toBe("Bearer test-grok-key");
      expect(captured.body.model).toBe("grok-4.6");
      expect(captured.body.max_completion_tokens).toBe(8192);
      expect(captured.body.response_format?.type).toBe("json_schema");
      expect(captured.body.response_format?.json_schema?.schema?.properties?.title).toEqual({ type: "string" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("streams by default so a slow call keeps its socket alive", () => {
    process.env.BILI_GROK_API_KEY = "test-grok-key";
    expect(buildGrokRequest({ prompt: "写标题" }).body.stream).toBe(true);
    expect(buildGrokRequest({ prompt: "写标题", stream: false }).body.stream).toBeUndefined();
  });

  test("reassembles streamed deltas into one answer", () => {
    const raw = [
      'data: {"choices":[{"delta":{"content":"{\\"title\\""}}]}',
      'data: {"choices":[{"delta":{"content":":\\"ok\\"}"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const streamed = extractStreamedText(raw);
    expect(streamed.content).toBe('{"title":"ok"}');
    expect(streamed.finishReason).toBe("stop");
    expect(streamed.completed).toBe(true);
  });

  test("treats a stream cut before completion as retryable rather than truncated JSON", async () => {
    process.env.BILI_GROK_API_KEY = "test-grok-key";
    const bodies = [
      'data: {"choices":[{"delta":{"content":"{\\"partial\\":"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ];
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(bodies.shift(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      const result = await runGrokProcess({
        prompt: "写标题",
        cwd: process.cwd(),
        timeoutMs: 60_000,
        sleep: async () => {},
      });
      expect(calls).toBe(2);
      expect(result.code).toBe(0);
      expect(result.attempts).toBe(2);
      expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reuses encoded frames until the file itself changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-img-cache-"));
    const image = join(dir, "frame1.jpg");
    try {
      clearImageDataUrlCache();
      writeFileSync(image, Buffer.from([0xff, 0xd8, 0x01, 0xd9]));
      const first = imageToDataUrl(image);
      expect(imageToDataUrl(image)).toBe(first);

      // A rewritten frame must invalidate the entry rather than serve stale bytes.
      writeFileSync(image, Buffer.from([0xff, 0xd8, 0x02, 0xd9]));
      const second = imageToDataUrl(image);
      expect(second).not.toBe(first);
      expect(second).toContain(Buffer.from([0xff, 0xd8, 0x02, 0xd9]).toString("base64"));
    } finally {
      clearImageDataUrlCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bounds the encoded-frame cache so a long-lived server cannot grow without limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-img-bound-"));
    try {
      clearImageDataUrlCache();
      for (let index = 0; index < 80; index += 1) {
        const image = join(dir, `frame${index}.jpg`);
        writeFileSync(image, Buffer.from([0xff, 0xd8, index & 0xff, 0xd9]));
        expect(imageToDataUrl(image)).toContain("base64,");
      }
      expect(imageDataUrlCacheSize()).toBeLessThanOrEqual(64);
    } finally {
      clearImageDataUrlCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("images become data URLs", async () => {
    process.env.BILI_GROK_API_KEY = "test-grok-key";
    const dir = mkdtempSync(join(tmpdir(), "grok-img-"));
    const image = join(dir, "frame1.jpg");
    writeFileSync(image, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    let captured: any = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
      }), { status: 200 });
    }) as typeof fetch;
    try {
      const request = buildGrokRequest({
        prompt: "看图写标题",
        model: "grok-4.5",
        images: [image],
      });
      const content = request.body.messages[0].content as Array<Record<string, any>>;
      const imagePart = content.find(part => part.type === "image_url");
      expect(imagePart?.image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
      expect(imagePart?.image_url?.url).toContain(Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"));

      const outputFile = join(dir, "out.json");
      const result = await runGrokProcess({
        prompt: "看图写标题",
        model: "grok-4.5",
        cwd: dir,
        timeoutMs: 5000,
        images: [image],
        outputFile,
      });
      expect(result.code).toBe(0);
      const sent = captured.messages[0].content as Array<Record<string, any>>;
      expect(sent.find(part => part.type === "image_url")?.image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("normalize and extract JSON from fenced or thinking output", () => {
    const fenced = "```json\n{\"title\":\"蒙古派对闯入一匹马\"}\n```";
    expect(extractJsonObject(fenced)).toEqual({ title: "蒙古派对闯入一匹马" });
    expect(extractJsonObject("<think>先想</think>{\"ok\":true}")).toEqual({ ok: true });
    expect(normalizeModelText("<think>x</think> hello")).toBe("hello");
  });

  test("auth status does not throw", () => {
    const status = grokAuthStatus();
    expect(typeof status.ready).toBe("boolean");
    expect(["env", "grok_oauth", "missing"]).toContain(status.source);
  });
});

describe("transport failure classification", () => {
  test("recognises the socket drop that downgraded real jobs", () => {
    expect(isTransportFailure(new Error("The socket connection was closed unexpectedly"))).toBe(true);
    expect(isTransportFailure(new Error("fetch failed"))).toBe(true);
    expect(isTransportFailure(new Error("read ECONNRESET"))).toBe(true);
    expect(isTransportFailure(new Error("unknown certificate verification error"))).toBe(true);
  });

  test("a model refusing to answer is not a transport failure", () => {
    expect(isTransportFailure(new Error("Grok 返回内容为空 (finish_reason=length)"))).toBe(false);
    expect(isTransportFailure(new Error("invalid_request_error"))).toBe(false);
    expect(isTransportFailure(undefined)).toBe(false);
  });

  test("only overload-style statuses are worth another round trip", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
  });
});

describe("runGrokProcess retries", () => {
  function stubFetch(responses: Array<() => Promise<Response>>) {
    let call = 0;
    globalThis.fetch = (async () => {
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return next();
    }) as typeof fetch;
    return () => call;
  }

  const okReply = () => Promise.resolve(new Response(JSON.stringify({
    choices: [{ message: { content: '{"ok":true}' } }],
  }), { status: 200 }));

  test("a dropped socket is retried on the same model instead of falling back", async () => {
    process.env.BILI_GROK_API_KEY = "test-grok-key";
    const calls = stubFetch([
      () => Promise.reject(new Error("The socket connection was closed unexpectedly")),
      okReply,
    ]);
    const retries: Array<{ attempt: number; reason: string }> = [];
    const result = await runGrokProcess({
      prompt: "只输出JSON",
      model: "grok-4.6",
      cwd: "/tmp",
      timeoutMs: 5 * 60 * 1000,
      sleep: async () => {},
      onRetry: info => retries.push({ attempt: info.attempt, reason: info.reason }),
    });
    expect(result.code).toBe(0);
    expect(result.attempts).toBe(2);
    expect(calls()).toBe(2);
    expect(retries).toHaveLength(1);
    expect(retries[0]?.reason).toContain("socket connection was closed");
  });

  test("a rate limit is retried, a bad request is not", async () => {
    process.env.BILI_GROK_API_KEY = "test-grok-key";
    const rateLimited = stubFetch([
      () => Promise.resolve(new Response("slow down", { status: 429 })),
      okReply,
    ]);
    const retried = await runGrokProcess({
      prompt: "p", model: "grok-4.6", cwd: "/tmp", timeoutMs: 5 * 60 * 1000, sleep: async () => {},
    });
    expect(retried.code).toBe(0);
    expect(rateLimited()).toBe(2);

    const rejected = stubFetch([() => Promise.resolve(new Response("bad schema", { status: 400 }))]);
    const result = await runGrokProcess({
      prompt: "p", model: "grok-4.6", cwd: "/tmp", timeoutMs: 5 * 60 * 1000, sleep: async () => {},
    });
    expect(result.code).toBe(1);
    expect(result.attempts).toBe(1);
    expect(rejected()).toBe(1);
    expect(result.stderr).toContain("400");
  });

  test("an empty completion is the model's answer and is never retried", async () => {
    process.env.BILI_GROK_API_KEY = "test-grok-key";
    const calls = stubFetch([() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: "" }, finish_reason: "length" }],
    }), { status: 200 }))]);
    const result = await runGrokProcess({
      prompt: "p", model: "grok-4.6", cwd: "/tmp", timeoutMs: 5 * 60 * 1000, sleep: async () => {},
    });
    expect(result.code).toBe(1);
    expect(result.attempts).toBe(1);
    expect(calls()).toBe(1);
    expect(result.stderr).toContain("finish_reason=length");
  });

  test("retries stop at the configured ceiling and report the transport reason", async () => {
    process.env.BILI_GROK_API_KEY = "test-grok-key";
    const calls = stubFetch([() => Promise.reject(new Error("socket hang up"))]);
    const result = await runGrokProcess({
      prompt: "p",
      model: "grok-4.6",
      cwd: "/tmp",
      timeoutMs: 5 * 60 * 1000,
      transportRetries: 2,
      sleep: async () => {},
    });
    expect(result.code).toBe(1);
    expect(result.attempts).toBe(3);
    expect(calls()).toBe(3);
    expect(result.stderr).toContain("socket hang up");
  });

  test("a budget too small for another attempt is not retried", async () => {
    process.env.BILI_GROK_API_KEY = "test-grok-key";
    const calls = stubFetch([() => Promise.reject(new Error("connection reset by peer"))]);
    const result = await runGrokProcess({
      prompt: "p",
      model: "grok-4.6",
      cwd: "/tmp",
      timeoutMs: 20_000,
      sleep: async () => {},
    });
    expect(result.code).toBe(1);
    expect(result.attempts).toBe(1);
    expect(calls()).toBe(1);
  });

  test("cancelling stops the retry loop", async () => {
    process.env.BILI_GROK_API_KEY = "test-grok-key";
    let kill: (() => void) | null = null;
    const calls = stubFetch([() => Promise.reject(new Error("The socket connection was closed unexpectedly"))]);
    const result = await runGrokProcess({
      prompt: "p",
      model: "grok-4.6",
      cwd: "/tmp",
      timeoutMs: 5 * 60 * 1000,
      onSpawn: child => { kill = () => child.kill(); },
      sleep: async () => { kill?.(); },
    });
    expect(result.code).toBe(1);
    expect(result.attempts).toBe(1);
    expect(calls()).toBe(1);
    expect(result.stderr).toContain("已取消");
  });

  test("an exhausted API key fails over to grok login instead of dying", async () => {
    process.env.BILI_GROK_API_KEY = "spent-team-key";
    const home = mkdtempSync(join(tmpdir(), "grok-oauth-"));
    process.env.GROK_HOME = home;
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
        key: "oauth-live-token",
        refresh_token: "refresh-live",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    }));
    const auths: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      auths.push(new Headers(init?.headers).get("Authorization") || "");
      if (auths.length === 1) {
        return new Response(JSON.stringify({
          code: "permission-denied",
          error: "Your team 082d3558 has either used all available credits or reached its monthly spending limit.",
        }), { status: 403 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
      }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await runGrokProcess({
        prompt: "p", model: "grok-4.6", cwd: "/tmp", timeoutMs: 5 * 60 * 1000, sleep: async () => {},
      });
      expect(isCreditLimitError(403, "used all available credits or reached its monthly spending limit")).toBe(true);
      expect(result.code).toBe(0);
      expect(auths).toEqual(["Bearer spent-team-key", "Bearer oauth-live-token"]);
      expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
