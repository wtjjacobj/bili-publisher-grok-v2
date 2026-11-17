import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, extname, join } from "path";

export const GROK_API_URL = "https://api.x.ai/v1/chat/completions";
export const GROK_PRIMARY_MODEL = process.env.BILI_GROK_PRIMARY_MODEL || "grok-4.6";
export const GROK_FALLBACK_MODEL = process.env.BILI_GROK_FALLBACK_MODEL || "grok-4.5";
export const GROK_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const GROK_OAUTH_ACCOUNT_KEY = `https://auth.x.ai::${GROK_OAUTH_CLIENT_ID}`;
export const DEFAULT_MAX_COMPLETION_TOKENS = 8192;
export const DEFAULT_TRANSPORT_RETRIES = 2;
export const TRANSPORT_RETRY_BASE_DELAY_MS = 1_500;
/** Below this much remaining budget a retry cannot finish, so stop trying. */
export const MIN_RETRY_BUDGET_MS = 45_000;

export type GrokAuthSource = "env" | "grok_oauth";
export type GrokReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface GrokProcessOptions {
  prompt: string;
  model?: string;
  cwd: string;
  timeoutMs: number;
  reasoningEffort?: GrokReasoningEffort;
  sandboxMode?: "read-only" | "workspace-write";
  networkAccess?: boolean;
  images?: string[];
  outputSchema?: string;
  outputFile?: string;
  /** Override the resolved Bearer token. Used to fail over between API key and grok login. */
  apiKey?: string;
  /** Extra attempts a dropped connection is worth. Defaults to DEFAULT_TRANSPORT_RETRIES. */
  transportRetries?: number;
  onSpawn?: (child: { kill: (signal?: string) => void }) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onRetry?: (info: { attempt: number; waitMs: number; reason: string }) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface GrokProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** How many round trips it took, including the ones that never answered. */
  attempts: number;
}

export function loadProjectEnv(envPath: string): void {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function grokHomeDir(): string {
  return process.env.GROK_HOME || join(homedir(), ".grok");
}

function grokOauthAuthPath(): string {
  return join(grokHomeDir(), "auth.json");
}

function readGrokOauthStore(): Record<string, any> | null {
  const authPath = grokOauthAuthPath();
  if (!existsSync(authPath)) return null;
  try {
    const store = JSON.parse(readFileSync(authPath, "utf-8"));
    return store && typeof store === "object" ? store : null;
  } catch {
    return null;
  }
}

function persistGrokOauthStore(store: Record<string, any>): void {
  const authPath = grokOauthAuthPath();
  const temporary = `${authPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf-8" });
  try { chmodSync(temporary, 0o600); } catch {}
  renameSync(temporary, authPath);
  try { chmodSync(authPath, 0o600); } catch {}
}

export function readGrokOauthAccessToken(): string {
  const store = readGrokOauthStore();
  const entry = store?.[GROK_OAUTH_ACCOUNT_KEY];
  const token = String(entry?.key || "").trim();
  if (!token) return "";
  const expiresAt = Date.parse(String(entry?.expires_at || ""));
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now() - 30_000) return "";
  return token;
}

const exhaustedCredentialSources = new Set<GrokAuthSource>();
let oauthRefreshInFlight: Promise<string> | null = null;

export function resetGrokCredentialState(): void {
  exhaustedCredentialSources.clear();
  oauthRefreshInFlight = null;
}

export function envGrokApiKey(): string {
  return (process.env.BILI_GROK_API_KEY || process.env.XAI_API_KEY || "").trim();
}

export function isCreditLimitError(status: number, body: string): boolean {
  if (status !== 403) return false;
  const text = `${body}`.toLowerCase();
  return text.includes("spending limit")
    || text.includes("used all available credits")
    || (text.includes("permission-denied") && text.includes("credit"));
}

export function isCredentialFailoverStatus(status: number, body: string): boolean {
  return status === 401 || isCreditLimitError(status, body);
}

async function refreshGrokOauthAccessToken(): Promise<string> {
  const store = readGrokOauthStore() || {};
  const entry = store[GROK_OAUTH_ACCOUNT_KEY];
  const refreshToken = String(entry?.refresh_token || "").trim();
  if (!refreshToken) {
    throw new Error("grok login 已过期且没有 refresh_token，请重新运行 grok login");
  }
  const response = await fetch(GROK_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: GROK_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`刷新 grok login 失败：HTTP ${response.status} ${raw.slice(0, 240)}`);
  }
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("刷新 grok login 返回了无法解析的响应");
  }
  const accessToken = String(payload?.access_token || "").trim();
  if (!accessToken) throw new Error("刷新 grok login 没有返回 access_token");
  const nextRefresh = String(payload?.refresh_token || refreshToken).trim();
  const expiresIn = Number(payload?.expires_in);
  const ttlMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 6 * 60 * 60 * 1000;
  const nextEntry = {
    ...(entry && typeof entry === "object" ? entry : {}),
    key: accessToken,
    refresh_token: nextRefresh,
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  };
  persistGrokOauthStore({ ...store, [GROK_OAUTH_ACCOUNT_KEY]: nextEntry });
  return accessToken;
}

export async function ensureGrokOauthAccessToken(): Promise<string> {
  const current = readGrokOauthAccessToken();
  if (current) return current;
  if (!oauthRefreshInFlight) {
    oauthRefreshInFlight = refreshGrokOauthAccessToken().finally(() => {
      oauthRefreshInFlight = null;
    });
  }
  return oauthRefreshInFlight;
}

export function resolveGrokCredentials(): { token: string; source: GrokAuthSource } {
  const envKey = envGrokApiKey();
  if (envKey && !exhaustedCredentialSources.has("env")) return { token: envKey, source: "env" };
  const oauth = readGrokOauthAccessToken();
  if (oauth) return { token: oauth, source: "grok_oauth" };
  if (envKey) return { token: envKey, source: "env" };
  throw new Error("缺少 Grok 凭证：请设置 BILI_GROK_API_KEY，或先运行 grok login");
}

export function readGrokApiKey(): string {
  return resolveGrokCredentials().token;
}

export function grokAuthStatus(): { ready: boolean; source: GrokAuthSource | "missing" } {
  try {
    return { ready: true, source: resolveGrokCredentials().source };
  } catch {
    return { ready: false, source: "missing" };
  }
}

export function normalizeModelText(text: string): string {
  let raw = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/s, "").trim();
  }
  return raw;
}

export function extractJsonObject(text: string): unknown | null {
  const raw = normalizeModelText(text);
  try {
    return JSON.parse(raw);
  } catch {}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function mimeForImage(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

/**
 * One job replays the same ten frames across analysis, both drafts and both
 * reviews, so encoding them once per request wastes CPU on identical output.
 * Entries are keyed by size and mtime so an overwritten frame is never served
 * stale, and the map is bounded because the server is long-lived.
 */
const IMAGE_DATA_URL_CACHE_LIMIT = 64;
const imageDataUrlCache = new Map<string, { fingerprint: string; url: string }>();

export function imageToDataUrl(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`图片不存在: ${path}`);
  }
  const stats = statSync(path);
  const fingerprint = `${stats.size}:${stats.mtimeMs}`;
  const cached = imageDataUrlCache.get(path);
  if (cached && cached.fingerprint === fingerprint) return cached.url;

  const data = readFileSync(path).toString("base64");
  const url = `data:${mimeForImage(path)};base64,${data}`;
  if (imageDataUrlCache.size >= IMAGE_DATA_URL_CACHE_LIMIT) {
    const oldest = imageDataUrlCache.keys().next();
    if (!oldest.done) imageDataUrlCache.delete(oldest.value);
  }
  imageDataUrlCache.set(path, { fingerprint, url });
  return url;
}

/** Exposed so tests can assert cache behaviour without leaking state between them. */
export function clearImageDataUrlCache(): void {
  imageDataUrlCache.clear();
}

export function imageDataUrlCacheSize(): number {
  return imageDataUrlCache.size;
}

export function buildGrokContent(prompt: string, images?: string[]): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const image of images || []) {
    content.push({
      type: "image_url",
      image_url: { url: imageToDataUrl(image) },
    });
  }
  return content;
}

export function buildGrokResponseFormat(outputSchema?: string): Record<string, unknown> | undefined {
  if (!outputSchema) return undefined;
  const raw = readFileSync(outputSchema, "utf-8");
  const schema = JSON.parse(raw);
  const fromFile = basename(outputSchema).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "_") || "grok_output";
  const name = typeof schema?.title === "string" && schema.title.trim()
    ? String(schema.title).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)
    : fromFile;
  return {
    type: "json_schema",
    json_schema: {
      name,
      schema,
      strict: true,
    },
  };
}

/**
 * Reassembles a server-sent-event body into the text a single response would
 * have carried. `completed` distinguishes a finished answer from a stream that
 * was cut mid-flight, which must be retried rather than parsed as truncated JSON.
 */
export function extractStreamedText(raw: string): {
  content: string;
  finishReason: string;
  error: string;
  completed: boolean;
} {
  let content = "";
  let finishReason = "";
  let error = "";
  let completed = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      completed = true;
      continue;
    }
    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event?.error) error = String(event.error?.message || event.error);
    const choice = event?.choices?.[0];
    if (!choice) continue;
    const piece = choice.delta?.content ?? choice.message?.content;
    if (typeof piece === "string") content += piece;
    if (choice.finish_reason) {
      finishReason = String(choice.finish_reason);
      completed = true;
    }
  }
  return { content, finishReason, error, completed };
}

export function isServerSentEvents(raw: string, contentType: string): boolean {
  if (contentType.toLowerCase().includes("text/event-stream")) return true;
  return /^\s*data:/.test(raw);
}

export function buildGrokRequest(options: {
  prompt: string;
  model?: string;
  images?: string[];
  outputSchema?: string;
  reasoningEffort?: GrokReasoningEffort;
  stream?: boolean;
  apiKey?: string;
}): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const apiKey = options.apiKey || readGrokApiKey();
  const model = options.model || GROK_PRIMARY_MODEL;
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: buildGrokContent(options.prompt, options.images) }],
    max_completion_tokens: DEFAULT_MAX_COMPLETION_TOKENS,
  };
  // The analysis call needs well over two minutes of model time, and a silent
  // connection gets cut at roughly one. Streaming keeps bytes moving so the
  // socket stays open; measured 101s failure without it, 148s success with it.
  if (options.stream !== false) body.stream = true;
  if (options.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort;
  }
  const responseFormat = buildGrokResponseFormat(options.outputSchema);
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  return {
    url: GROK_API_URL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body,
  };
}

/**
 * A transport failure never produced a verdict: the socket dropped, DNS failed,
 * the peer reset the connection. The right response is to ask the same model
 * again. Switching models here is what silently downgraded 5 of 8 recorded jobs
 * from grok-4.6 to grok-4.5 without anyone deciding to.
 */
const TRANSPORT_FAILURE_PATTERNS = [
  "socket connection was closed",
  "socket hang up",
  "connection closed",
  "connection reset",
  "connection refused",
  "premature close",
  "network error",
  "fetch failed",
  "failed to fetch",
  "unable to connect",
  "econnreset",
  "econnrefused",
  "econnaborted",
  "epipe",
  "etimedout",
  "enotfound",
  "eai_again",
  "unknown certificate verification error",
  "certificate verification",
  "unable to verify the first certificate",
  "err_tls_cert_authority_invalid",
];

/** Statuses where the request was accepted but the far side could not answer yet. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524]);

export function isTransportFailure(reason: unknown): boolean {
  const message = String((reason as { message?: unknown })?.message ?? reason ?? "").toLowerCase();
  if (!message) return false;
  return TRANSPORT_FAILURE_PATTERNS.some(pattern => message.includes(pattern));
}

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

export function transportRetryDelayMs(attempt: number): number {
  return TRANSPORT_RETRY_BASE_DELAY_MS * attempt;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractAssistantText(payload: any): string {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (typeof part === "string") return part;
      return part?.text || part?.content || "";
    }).join("");
  }
  return "";
}

type AttemptOutcome =
  | { kind: "ok"; normalized: string }
  | { kind: "model"; message: string; body?: string; status?: number }
  | { kind: "transport"; message: string }
  | { kind: "aborted"; message: string; timedOut: boolean };

async function runGrokAttempt(
  url: string,
  headers: Record<string, string>,
  body: string,
  budgetMs: number,
  cancel: { aborted: boolean },
  registerAbort: (abort: () => void) => void,
): Promise<AttemptOutcome> {
  const abort = new AbortController();
  let timedOut = false;
  registerAbort(() => abort.abort());
  if (cancel.aborted) abort.abort();
  const timeout = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, budgetMs);
  try {
    const response = await fetch(url, { method: "POST", headers, body, signal: abort.signal });
    const raw = await response.text();
    if (!response.ok) {
      const message = `Grok HTTP ${response.status}: ${raw.slice(-800)}`;
      return isRetryableStatus(response.status)
        ? { kind: "transport", message }
        : { kind: "model", message, status: response.status, body: raw };
    }
    let content = "";
    let reason = "";
    if (isServerSentEvents(raw, response.headers.get("content-type") || "")) {
      const streamed = extractStreamedText(raw);
      if (streamed.error) return { kind: "model", message: `Grok 流式返回错误: ${streamed.error}` };
      // A stream that stopped without [DONE] or a finish_reason lost its socket
      // partway, so the partial text must not be parsed as a complete answer.
      if (!streamed.completed) return { kind: "transport", message: "Grok 流式响应在完成前中断" };
      content = streamed.content.trim();
      reason = streamed.finishReason;
    } else {
      let payload: any;
      try {
        payload = JSON.parse(raw);
      } catch {
        return { kind: "model", message: "Grok 返回了无法解析的响应", body: raw };
      }
      content = extractAssistantText(payload).trim();
      reason = payload?.choices?.[0]?.finish_reason || payload?.error?.message || "";
    }
    if (!content) {
      return { kind: "model", message: `Grok 返回内容为空 (finish_reason=${reason || "empty"})` };
    }
    const parsed = extractJsonObject(content);
    return { kind: "ok", normalized: parsed === null ? normalizeModelText(content) : JSON.stringify(parsed) };
  } catch (err: any) {
    const message = err?.message || String(err);
    if (timedOut) return { kind: "aborted", message: "Grok 调用超时", timedOut: true };
    if (cancel.aborted) return { kind: "aborted", message: `Grok 调用已取消: ${message}`, timedOut: false };
    if (isTransportFailure(err)) return { kind: "transport", message: `Grok 调用异常: ${message}` };
    return { kind: "model", message: `Grok 调用异常: ${message}` };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runGrokProcess(options: GrokProcessOptions): Promise<GrokProcessResult> {
  const request = buildGrokRequest({ ...options, apiKey: options.apiKey || "pending" });
  // Serialize once: with 10 inlined frames this string can reach several MB,
  // and a retry must not pay to build it again. Auth headers change per credential.
  const body = JSON.stringify(request.body);
  const sleep = options.sleep || defaultSleep;
  const maxRetries = Math.max(0, options.transportRetries ?? DEFAULT_TRANSPORT_RETRIES);
  const deadline = Date.now() + options.timeoutMs;

  const cancel = { aborted: false };
  let abortCurrent: (() => void) | null = null;
  options.onSpawn?.({
    kill() {
      cancel.aborted = true;
      abortCurrent?.();
    },
  });

  let stdout = "";
  let stderr = "";
  const emitOut = (chunk: string) => {
    stdout += chunk;
    options.onStdout?.(chunk);
  };
  const emitErr = (chunk: string) => {
    stderr += chunk;
    options.onStderr?.(chunk);
  };

  const credentials: Array<{ token: string; source: GrokAuthSource }> = [];
  const explicitKey = String(options.apiKey || "").trim();
  if (explicitKey) {
    credentials.push({ token: explicitKey, source: envGrokApiKey() === explicitKey ? "env" : "grok_oauth" });
  } else {
    const envKey = envGrokApiKey();
    if (envKey && !exhaustedCredentialSources.has("env")) credentials.push({ token: envKey, source: "env" });
  }

  const loadOauthFallback = async (): Promise<boolean> => {
    if (explicitKey || exhaustedCredentialSources.has("grok_oauth")) return false;
    if (credentials.some(item => item.source === "grok_oauth")) return false;
    try {
      const oauth = await ensureGrokOauthAccessToken();
      if (!oauth) return false;
      credentials.push({ token: oauth, source: "grok_oauth" });
      return true;
    } catch (error: any) {
      emitErr(error?.message || String(error));
      return false;
    }
  };

  if (credentials.length === 0) {
    await loadOauthFallback();
  }
  if (credentials.length === 0) {
    throw new Error("缺少 Grok 凭证：请设置 BILI_GROK_API_KEY，或先运行 grok login");
  }

  let attempts = 0;
  let lastTransport = "";
  let lastModel = "";
  for (let credIndex = 0; credIndex < credentials.length; credIndex += 1) {
    const cred = credentials[credIndex];
    const headers = {
      Authorization: `Bearer ${cred.token}`,
      "Content-Type": "application/json",
    };
    lastTransport = "";
    for (let attempt = 1; ; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        emitErr(lastTransport ? `${lastTransport}（重试预算已用尽）` : "Grok 调用超时");
        return { code: 1, stdout, stderr, timedOut: true, attempts };
      }
      attempts += 1;
      const outcome = await runGrokAttempt(
        request.url,
        headers,
        body,
        remaining,
        cancel,
        next => { abortCurrent = next; },
      );
      abortCurrent = null;

      if (outcome.kind === "ok") {
        emitOut(outcome.normalized);
        if (options.outputFile) writeFileSync(options.outputFile, `${outcome.normalized}\n`);
        return { code: 0, stdout, stderr, timedOut: false, attempts };
      }
      if (outcome.kind === "aborted") {
        emitErr(outcome.message);
        return { code: 1, stdout, stderr, timedOut: outcome.timedOut, attempts };
      }
      if (outcome.kind === "model") {
        const failover = outcome.status !== undefined
          && isCredentialFailoverStatus(outcome.status, `${outcome.message}\n${outcome.body || ""}`);
        if (failover) {
          exhaustedCredentialSources.add(cred.source);
          const switched = cred.source === "env" ? await loadOauthFallback() : false;
          if (switched || credIndex < credentials.length - 1) {
            options.onRetry?.({
              attempt,
              waitMs: 0,
              reason: cred.source === "env"
                ? "API Key 额度或权限不足，改用 grok login"
                : "grok login 不可用，改用 API Key",
            });
            lastModel = outcome.message;
            break;
          }
        }
        emitErr(outcome.message);
        if (outcome.body !== undefined) emitOut(outcome.body);
        return { code: 1, stdout, stderr, timedOut: false, attempts };
      }

      lastTransport = outcome.message;
      const waitMs = transportRetryDelayMs(attempt);
      const budgetLeft = deadline - Date.now() - waitMs;
      if (attempt > maxRetries || budgetLeft < MIN_RETRY_BUDGET_MS || cancel.aborted) {
        emitErr(outcome.message);
        return { code: 1, stdout, stderr, timedOut: false, attempts };
      }
      options.onRetry?.({ attempt, waitMs, reason: outcome.message });
      await sleep(waitMs);
      if (cancel.aborted) {
        emitErr(`Grok 调用已取消: ${outcome.message}`);
        return { code: 1, stdout, stderr, timedOut: false, attempts };
      }
    }
  }

  emitErr(lastModel || lastTransport || "Grok 调用失败");
  return { code: 1, stdout, stderr, timedOut: false, attempts };
}
