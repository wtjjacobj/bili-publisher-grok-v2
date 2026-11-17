import { resolve, sep } from "path";
import { existsSync, lstatSync, realpathSync, statSync } from "fs";

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function buildCodexArgs(options: {
  prompt: string;
  model: string;
  cwd: string;
  reasoningEffort?: "low" | "medium" | "high";
  sandboxMode?: "read-only" | "workspace-write";
  networkAccess?: boolean;
  images?: string[];
  outputSchema?: string;
  outputFile?: string;
}): string[] {
  const sandboxMode = options.sandboxMode || "workspace-write";
  const args = [
    "--disable", "plugins",
    "--disable", "skill_search",
    "--disable", "apps",
    "--disable", "multi_agent",
    "--disable", "tool_suggest",
    "--disable", "hooks",
    "-s", sandboxMode,
    "-a", "never",
    "-m", options.model,
    "-c", `model_reasoning_effort=\"${options.reasoningEffort || "low"}\"`,
    "-C", options.cwd,
  ];
  if (sandboxMode === "workspace-write") {
    args.push("-c", `sandbox_workspace_write.network_access=${options.networkAccess !== false}`);
  }
  args.push(
    "exec",
  );
  for (const image of options.images || []) args.push("-i", image);
  args.push(
    "--color", "never",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
  );
  if (options.outputSchema) args.push("--output-schema", options.outputSchema);
  if (options.outputFile) args.push("--output-last-message", options.outputFile);
  args.push(options.prompt);
  return args;
}

export function validateJobId(value: unknown): string {
  if (typeof value !== "string" || !JOB_ID_PATTERN.test(value)) {
    throw new Error("无效的jobId");
  }
  return value;
}

export function isPathInside(basePath: string, candidatePath: string): boolean {
  const base = resolve(basePath);
  const candidate = resolve(candidatePath);
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

export function resolveJobDir(workspace: string, jobId: unknown): string {
  const safeJobId = validateJobId(jobId);
  const jobDir = resolve(workspace, safeJobId);
  if (!isPathInside(workspace, jobDir) || jobDir === resolve(workspace)) {
    throw new Error("Job路径越界");
  }
  if (existsSync(jobDir)) {
    const stats = lstatSync(jobDir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("Job目录类型无效");
    const realWorkspace = realpathSync(workspace);
    const realJobDir = realpathSync(jobDir);
    if (!isPathInside(realWorkspace, realJobDir) || realJobDir === realWorkspace) {
      throw new Error("Job真实路径越界");
    }
  }
  return jobDir;
}

export function resolveJobPath(workspace: string, jobId: unknown, ...segments: string[]): string {
  const jobDir = resolveJobDir(workspace, jobId);
  const candidate = resolve(jobDir, ...segments);
  if (!isPathInside(jobDir, candidate)) {
    throw new Error("Job文件路径越界");
  }
  return candidate;
}

export function assertPathInside(basePath: string, candidatePath: unknown, label = "文件"): string {
  if (typeof candidatePath !== "string" || !candidatePath) {
    throw new Error(`${label}路径缺失`);
  }
  const resolvedPath = resolve(candidatePath);
  if (!isPathInside(basePath, resolvedPath) || resolvedPath === resolve(basePath)) {
    throw new Error(`${label}路径越界`);
  }
  return resolvedPath;
}

export function assertExistingFileInside(basePath: string, candidatePath: unknown, label = "文件"): string {
  const lexicalPath = assertPathInside(basePath, candidatePath, label);
  let realBase: string;
  let realCandidate: string;
  try {
    realBase = realpathSync(basePath);
    realCandidate = realpathSync(lexicalPath);
  } catch {
    throw new Error(`${label}不存在`);
  }
  if (!isPathInside(realBase, realCandidate) || realCandidate === realBase || !statSync(realCandidate).isFile()) {
    throw new Error(`${label}路径越界或不是普通文件`);
  }
  return realCandidate;
}

export function isTrustedHost(host: string | null, port: number): boolean {
  if (!host) return false;
  return new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]).has(host.toLowerCase());
}

export function isMutationRequestAllowed(req: Request, port: number): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;

  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;

  const origin = req.headers.get("origin");
  if (!origin) return fetchSite === "same-origin" || fetchSite === "same-site" || fetchSite === "none";

  try {
    const parsed = new URL(origin);
    const expectedPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return parsed.protocol === "http:"
      && expectedPort === String(port)
      && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1");
  } catch {
    return false;
  }
}

export const PREPARE_TIMEOUT_MS = 3 * 60 * 60 * 1000;
export const MAX_AGENT_TIME_MS = 8 * 60 * 60 * 1000;

export interface JobRecoveryState {
  hasResult: boolean;
  hasBrief: boolean;
  hasPrepared: boolean;
  hasRequest?: boolean;
}

/**
 * Recovery must be offered for jobs handleContinue accepts: local preparation
 * finished with no copy yet, or a request that never finished downloading.
 * A job whose analysis died on a network error has no fact card, but its
 * download, frames and transcript are all still on disk, so gating on the
 * fact card would throw that work away.
 */
export function jobCanContinue(state: JobRecoveryState): boolean {
  if (state.hasResult) return false;
  return state.hasPrepared || Boolean(state.hasRequest);
}

/** Hiding a continuable job strands its prepared media with no way back to it. */
export function jobIsListable(state: JobRecoveryState): boolean {
  return state.hasResult || state.hasBrief || jobCanContinue(state);
}

export function normalizeTid(value: unknown): number {
  if (value === "" || value === null || value === undefined) {
    throw new Error("缺少B站分区ID");
  }
  const tid = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(tid) || tid < 1 || tid > 9999) {
    throw new Error("B站分区ID必须是1到9999之间的整数");
  }
  return tid;
}

export function normalizePositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`参数必须是1到${max}之间的整数`);
  }
  return parsed;
}

export function buildRescreenshotTimestamps(duration: number, count: number, revision: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("无效的视频时长");
  }
  if (!Number.isInteger(count) || count < 1 || count > 32) {
    throw new Error("无效的截图数量");
  }
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error("无效的截图版本");
  }

  // Each revision samples a different point inside every evenly divided segment.
  // Cycling through 20%/40%/60%/80% keeps every frame away from video boundaries,
  // while ensuring consecutive clicks never produce the same timestamps.
  const phase = (((revision - 1) % 4) + 1) / 5;
  const interval = duration / count;
  return Array.from({ length: count }, (_, index) =>
    Number(((index + phase) * interval).toFixed(6))
  );
}

export function normalizeSplitPoints(value: unknown, duration: number, maxPoints = 20): number[] {
  if (!Array.isArray(value) || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("无效的分割参数");
  }
  if (value.length > maxPoints) {
    throw new Error(`分割点不能超过${maxPoints}个`);
  }

  const points = value.map(Number);
  if (points.some(point => !Number.isFinite(point) || point <= 0 || point >= duration)) {
    throw new Error("分割点必须位于视频有效时长内");
  }
  return [...new Set(points)].sort((a, b) => a - b);
}

export function validateSourceUrl(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 2048) {
    throw new Error("无效的视频链接");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("无效的视频链接");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("视频链接仅支持http或https");
  }
  if (parsed.username || parsed.password) throw new Error("视频链接不能包含账号信息");

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateHost = hostname === "localhost"
    || hostname === "::1"
    || hostname === "0.0.0.0"
    || hostname.endsWith(".local")
    || /^127\./.test(hostname)
    || /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^169\.254\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    || /^fc|^fd|^fe80:/i.test(hostname);
  if (!hostname || privateHost) throw new Error("视频链接不能指向本机或内网地址");
  return parsed.toString();
}

export function extractSourceUrl(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  const candidate = (match ? match[0] : text).replace(/[)\].,，。>]+$/g, "");
  return validateSourceUrl(candidate);
}

export function concisePrepareError(stderr: string, timedOut = false): string {
  if (timedOut) return "视频下载或封面处理超时";
  const text = String(stderr || "").replace(/\u0000/g, "").trim();
  if (!text) return "视频下载或封面处理失败";
  const meaningful = text.split(/\r?\n/).map(line => line.trim()).filter(line =>
    line
    && !/^WARNING:/i.test(line)
    && !/older than 90 days/i.test(line)
    && !/suppress this warning/i.test(line)
    && !/^It is strongly recommended/i.test(line)
    && !/^You installed yt-dlp/i.test(line)
    && !/^To suppress/i.test(line)
  );
  const joined = meaningful.join("\n");
  if (/HTTP Error 403|403 Forbidden/i.test(joined) && !/YouTube 拒绝下载/.test(joined)) {
    return "YouTube 拒绝下载（403）。过几分钟再试。";
  }
  if (/Sign in to confirm|not a bot/i.test(joined) && !/请先在 Chrome/.test(joined)) {
    return "YouTube 要求登录验证。请先在 Chrome 打开并登录 YouTube，然后再试。";
  }
  if (/Requested format is not available|Only images are available/i.test(joined)) {
    return "YouTube 没有给出可下载的视频流。换一个链接，或过几分钟再试。";
  }
  if (/Private video|Video unavailable/i.test(joined)) {
    return "这个视频不可用，可能已删除、设为私密，或当前网络看不了。";
  }
  const prepared = [...meaningful].reverse().find(line =>
    line.startsWith("视频准备失败：") || line.startsWith("YouTube") || line.startsWith("视频")
  );
  if (prepared) return prepared.replace(/^视频准备失败：/, "").slice(0, 280);
  const errorLine = [...meaningful].reverse().find(line => /^ERROR:/i.test(line));
  if (errorLine) return errorLine.replace(/^ERROR:\s*/i, "").slice(0, 280);
  return (meaningful.at(-1) || "视频下载或封面处理失败").slice(0, 280);
}

export function assessGeneratedResult(value: unknown): string[] {
  const issues: string[] = [];
  if (!value || typeof value !== "object") return ["result.json不是对象"];
  const result = value as Record<string, unknown>;

  const titles = Array.isArray(result.title_candidates)
    ? result.title_candidates.filter(title => typeof title === "string" && title.trim()) as string[]
    : [];
  if (titles.length !== 5) issues.push("标题候选必须恰好5个");
  if (new Set(titles.map(title => title.trim())).size !== titles.length) issues.push("标题候选不能重复");
  if (titles.some(title => title.length > 30)) issues.push("标题候选过长");
  if (!Number.isInteger(result.recommended_title_index)
    || Number(result.recommended_title_index) < 0
    || Number(result.recommended_title_index) >= titles.length) {
    issues.push("推荐标题索引必须指向现有候选标题");
  }

  const tags = Array.isArray(result.tags)
    ? result.tags.filter(tag => typeof tag === "string" && tag.trim()) as string[]
    : [];
  if (tags.length !== 10) issues.push("标签必须恰好10个");
  if (new Set(tags.map(tag => tag.trim())).size !== tags.length) issues.push("标签不能重复");

  const description = typeof result.description === "string" ? result.description.trim() : "";
  if (description.length < 60) issues.push("简介少于60字");
  if (description.length > 1000) issues.push("简介超过1000字");
  try { normalizeTid(result.tid); } catch { issues.push("缺少有效的B站分区tid"); }
  if (typeof result.video_file !== "string" || !result.video_file) issues.push("缺少视频文件路径");
  if (!Array.isArray(result.screenshots) || result.screenshots.length < 3) issues.push("封面候选少于3张");
  return issues;
}

export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(";").flatMap(part => {
    const separator = part.indexOf("=");
    if (separator < 0) return [];
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    return key ? [[key, value]] : [];
  }));
}
