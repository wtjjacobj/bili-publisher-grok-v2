// @ts-nocheck
/**
 * B站投稿助手 Web 仪表盘 v2（Grok 驱动，借鉴 Codex harness 工作方式）
 * 独立于 Documents/B站投稿-grok，不覆盖 3457 原版。
 * 固定本地程序负责视频准备，Grok只生成文案，本地Python脚本负责B站草稿上传
 */
import { serve } from "bun";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, unlinkSync, statSync, chmodSync, copyFileSync, renameSync } from "fs";
import { join, extname } from "path";
import { randomBytes, timingSafeEqual } from "crypto";
import {
  assertExistingFileInside,
  assessGeneratedResult,
  buildRescreenshotTimestamps,
  concisePrepareError,
  extractSourceUrl,
  isMutationRequestAllowed,
  isPathInside,
  isTrustedHost,
  jobCanContinue,
  jobIsListable,
  MAX_AGENT_TIME_MS,
  PREPARE_TIMEOUT_MS,
  normalizePositiveInt,
  normalizeSplitPoints,
  normalizeTid,
  parseCookies,
  resolveJobDir,
  resolveJobPath,
  validateJobId,
} from "./server_utils";
import {
  canResumeFromBrief,
  loadTranscript,
  readPersistedBrief,
  runMetadataPipeline,
  validateDistinctAgentModels,
  type MetadataModelRequest,
} from "./metadata_pipeline";
import { uiHelpersResponse } from "./ui_helpers_route";
import { grokAuthStatus, loadProjectEnv, runGrokProcess } from "./grok_model";
import {
  buildChineseSubtitleTranslatePrompt,
  materializeChineseSubtitles,
  subtitleGlossaryFromBrief,
  SUBTITLE_FFMPEG,
  SUBTITLE_SRT_NAME,
  SUBTITLE_VIDEO_NAME,
  userExplicitlyRequestedChineseSubtitles,
  userRequestedChineseSubtitles,
} from "./chinese_subtitles";
import { chatPatchFromModel } from "./grok_chat";
import { applyChatTurn, buildChatTurnPrompt } from "./chat_turn";
import { appendStageEvent, readStageEvents } from "./job_events";
import { appendCallTrace, readCallTraces } from "./job_trace";
import { startChannelsDraft } from "./channels_bridge";
import {
  channelsPostRequested,
  localArchiveDir,
  saveSubmittedVideos,
} from "./post_options";
import {
  acknowledgeApprovals,
  buildApprovalItems,
  readApprovals,
  replaceApprovalsPreservingAck,
  unacknowledgedApprovals,
} from "./job_approvals";
import { lookupEntities } from "./entity_lookup";
import {
  createTitleBranch,
  listTitleBranches,
  readTitleBranch,
  summarizeBranch,
} from "./title_branches";

loadProjectEnv(join(import.meta.dir, ".env"));

const PORT = Number(process.env.BILI_PUBLISHER_PORT || 3459);
const HOSTNAME = "127.0.0.1";
const ROOT = process.env.BILI_PUBLISHER_ROOT || "/Users/wangtangjie/Documents/B站投稿-grok-v2";
const WORKSPACE = `${ROOT}/workspace`;
const AUTH_TOKEN_FILE = join(ROOT, ".auth-token");
const PREPARE_SCRIPT = join(ROOT, "prepare_video.py");
const METADATA_SCHEMA = join(ROOT, "metadata_schema.json");
const CONTENT_BRIEF_SCHEMA = join(ROOT, "content_brief_schema.json");
const METADATA_REVIEW_SCHEMA = join(ROOT, "metadata_review_schema.json");
const SUBTITLE_CUES_SCHEMA = join(ROOT, "subtitle_cues_schema.json");
const AUTH_COOKIE = "bili_publisher_grok_v2_auth";
const MAX_CONCURRENT_AGENTS = 2;
const MAX_CHAT_MESSAGE_LENGTH = 2000;
const MAX_REQUEST_BODY_SIZE = 1024 * 1024;
const MAX_UPLOAD_TIME_MS = 6 * 60 * 60 * 1000;
const ALLOWED_ASSET_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".mp4", ".webm"]);
const REAL_USER_HOME = process.env.BILI_PUBLISHER_USER_HOME || "/Users/wangtangjie";
const PRIMARY_AGENT_MODEL = process.env.BILI_PUBLISHER_PRIMARY_MODEL || process.env.BILI_GROK_PRIMARY_MODEL || "grok-4.6";
const FALLBACK_AGENT_MODEL = process.env.BILI_PUBLISHER_FALLBACK_MODEL || process.env.BILI_GROK_FALLBACK_MODEL || "grok-4.5";

if (![PRIMARY_AGENT_MODEL, FALLBACK_AGENT_MODEL].every(model => /^[A-Za-z0-9._:/-]{1,100}$/.test(model))) {
  throw new Error("Agent模型名称格式无效");
}
validateDistinctAgentModels(PRIMARY_AGENT_MODEL, FALLBACK_AGENT_MODEL);

mkdirSync(WORKSPACE, { recursive: true });

function loadOrCreateAuthToken(): string {
  try {
    const existing = readFileSync(AUTH_TOKEN_FILE, "utf-8").trim();
    if (/^[a-f0-9]{64}$/.test(existing)) {
      chmodSync(AUTH_TOKEN_FILE, 0o600);
      return existing;
    }
  } catch {}
  const token = randomBytes(32).toString("hex");
  writeFileSync(AUTH_TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  chmodSync(AUTH_TOKEN_FILE, 0o600);
  return token;
}

const AUTH_TOKEN = loadOrCreateAuthToken();

function tokenMatches(value: string | undefined): boolean {
  if (!value) return false;
  const expected = Buffer.from(AUTH_TOKEN);
  const actual = Buffer.from(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isAuthorized(req: Request): boolean {
  const headerToken = req.headers.get("x-app-token") || undefined;
  const cookieToken = parseCookies(req.headers.get("cookie"))[AUTH_COOKIE];
  return tokenMatches(headerToken) || tokenMatches(cookieToken);
}

function authCookieHeader(): string {
  return `${AUTH_COOKIE}=${AUTH_TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
}

function jobDir(jobId: unknown): string {
  return resolveJobDir(WORKSPACE, jobId);
}

function jobPath(jobId: unknown, ...segments: string[]): string {
  return resolveJobPath(WORKSPACE, jobId, ...segments);
}

function readJobResult(jobId: unknown): any {
  return JSON.parse(readFileSync(jobPath(jobId, "result.json"), "utf-8"));
}

function safeJobAsset(jobId: unknown, candidate: unknown, label: string): string {
  return assertExistingFileInside(jobDir(jobId), candidate, label);
}

function jsonError(message: string, status: number): Response {
  return Response.json({ success: false, error: message }, { status });
}

const activeAgentJobs = new Map<string, any>();
const activePublishJobs = new Set<string>();
const activeChatJobs = new Set<string>();
const activeMediaJobs = new Set<string>();

// WebSocket客户端连接管理
const clients = new Map<string, { ws: any; jobId: string | null }>();

// 广播给所有连接的客户端（或指定job的客户端）
function broadcast(data: object, targetJobId?: string) {
  const payload = JSON.stringify(data);
  clients.forEach((client, _clientId) => {
    if (!targetJobId || client.jobId === targetJobId) {
      try {
        client.ws.send(payload);
      } catch { /* 连接可能已关闭 */ }
    }
  });
}

// 更新进度文件
function emitJobStage(jobId: string, event: {
  stage: string;
  status: "started" | "completed" | "failed" | "skipped";
  message: string;
  attempt?: number;
  model?: string;
}) {
  const stored = appendStageEvent(jobDir(jobId), event);
  broadcast({ type: "stage", ...stored }, jobId);
  return stored;
}

function persistJobApprovals(jobId: string) {
  const brief = readPersistedBrief(jobDir(jobId));
  let copyStatus = "";
  let reviewIssues: string[] = [];
  try {
    const result = readJobResult(jobId);
    copyStatus = String(result.copy_status || "");
    reviewIssues = [...(result.review_issues || []), ...(result.deterministic_issues || [])].map(String);
  } catch {}
  let lookups: any[] = [];
  try {
    const lookupPath = jobPath(jobId, "lookup_results.json");
    if (existsSync(lookupPath)) lookups = JSON.parse(readFileSync(lookupPath, "utf-8"));
  } catch {}
  const items = buildApprovalItems({ brief, copyStatus, reviewIssues, lookups: Array.isArray(lookups) ? lookups : [] });
  return replaceApprovalsPreservingAck(jobDir(jobId), items);
}

function updateProgress(jobDir: string, step: number, total: number, message: string, percent: number) {
  const progressPath = jobPath(jobDir, "progress.json");
  try {
    writeFileSync(progressPath, JSON.stringify({ step, total, message, percent }, null, 2));
  } catch { /* ignore */ }
  broadcast({ type: "progress", step, total, message, percent }, jobDir);
}

function appendTail(current: string, chunk: string, maxLength = 50_000): string {
  const combined = current + chunk;
  return combined.length > maxLength ? combined.slice(-maxLength) : combined;
}

function assessJobResult(jobId: string): string[] {
  try {
    const result = readJobResult(jobId);
    const issues = assessGeneratedResult(result);
    try { safeJobAsset(jobId, result.video_file, "视频"); } catch (err: any) { issues.push(err.message); }
    if (Array.isArray(result.screenshots)) {
      for (const screenshot of result.screenshots.slice(0, 5)) {
        try { safeJobAsset(jobId, screenshot, "封面"); } catch (err: any) { issues.push(err.message); break; }
      }
    }
    return [...new Set(issues)];
  } catch (err: any) {
    return [`结果文件无法读取: ${err.message}`];
  }
}

function conciseAgentError(output: { stdout: string; stderr: string; timedOut: boolean }): string {
  if (output.timedOut) return "模型调用超时";
  const raw = `${output.stderr}\n${output.stdout}`.trim();
  if (/HTTP 401|unauthorized|not logged in|login required|authentication|api key/i.test(raw)) {
    return "Grok/xAI API key 无效或未设置，请检查 BILI_GROK_API_KEY";
  }
  if (/ENOENT|No such file or directory/i.test(raw)) return "Grok 调用失败，请确认本机可访问 api.x.ai";
  if (/model.*not found|unknown model|unsupported model/i.test(raw)) return "当前 xAI 账号不可用所选 Grok 模型";
  return raw.slice(-300) || "模型未返回结果";
}

function runVideoPrepare(jobId: string, url: string, controller: any): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const { spawn } = require("child_process");
    const child = spawn("/opt/homebrew/Caskroom/miniforge/base/bin/python3", [
      PREPARE_SCRIPT,
      "--url", url,
      "--job-dir", jobDir(jobId),
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: ROOT,
      env: { ...process.env, HOME: REAL_USER_HOME },
    });
    controller.child = child;
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      controller.child = null;
      resolve({ code, stdout, stderr, timedOut });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { if (!finished) try { child.kill("SIGKILL"); } catch {} }, 5000);
    }, PREPARE_TIMEOUT_MS);
    child.stdout.on("data", (data: Buffer) => { stdout = appendTail(stdout, data.toString()); });
    child.stderr.on("data", (data: Buffer) => {
      stderr = appendTail(stderr, data.toString());
      console.error(`[${jobId}][prepare] ${data.toString().trim().slice(0, 300)}`);
    });
    child.on("close", (code: number) => finish(code ?? 1));
    child.on("error", (err: Error) => {
      stderr = appendTail(stderr, err.message);
      finish(1);
    });
  });
}

function parseJsonReply(path: string): any {
  let raw = readFileSync(path, "utf-8").trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  return JSON.parse(raw);
}

function readBurnSubtitlesFlag(jobId: string): boolean | undefined {
  try {
    const request = JSON.parse(readFileSync(jobPath(jobId, "request.json"), "utf-8"));
    if (typeof request.burnChineseSubtitles === "boolean") return request.burnChineseSubtitles;
  } catch {}
  return undefined;
}

function newJobController(): any {
  return {
    child: null,
    exitCode: null,
    signalCode: null,
    cancelled: false,
    lastError: "",
    model: PRIMARY_AGENT_MODEL,
    kill(signal = "SIGTERM") {
      this.cancelled = true;
      this.signalCode = signal;
      if (this.child) try { this.child.kill(signal); } catch {}
    },
  };
}

async function applyChineseSubtitles(options: {
  jobId: string;
  controller: any;
  userDescription: string;
  transcript: { status?: string; language?: string; segments?: Array<{ start: number; end: number; text: string }> };
  sourceVideoFile: string;
}): Promise<{ videoFile: string; subtitleFile: string } | null> {
  const { jobId, controller, userDescription, transcript, sourceVideoFile } = options;
  const existingVideo = jobPath(jobId, SUBTITLE_VIDEO_NAME);
  const existingSrt = jobPath(jobId, SUBTITLE_SRT_NAME);
  if (existsSync(existingVideo) && existsSync(existingSrt) && statSync(existingVideo).size > 1024) {
    emitJobStage(jobId, { stage: "subtitles", status: "skipped", message: "沿用已烧录的中文字幕成片" });
    return {
      videoFile: safeJobAsset(jobId, existingVideo, "视频"),
      subtitleFile: existingSrt,
    };
  }
  updateProgress(jobId, 3, 5, "正在生成中文字幕", 58);
  emitJobStage(jobId, { stage: "subtitles", status: "started", message: "正在生成并烧录中文字幕" });
  const burned = await materializeChineseSubtitles({
    videoFile: sourceVideoFile,
    artifactDir: jobDir(jobId),
    cues: transcript.segments || [],
    language: transcript.language,
    context: userDescription,
    ffmpegBin: SUBTITLE_FFMPEG,
    isCancelled: () => controller.cancelled,
    onProgress: message => updateProgress(jobId, 3, 5, message, 60),
    onSpawn: child => { controller.child = child; },
    translate: async (request) => {
      const runTranslate = async (model: string, attempt: number) => {
        const outputFile = jobPath(jobId, `_subtitle_translate_${request.batch[0].index}_${attempt}.json`);
        try { unlinkSync(outputFile); } catch {}
        let context = userDescription;
        try {
          if (existsSync(jobPath(jobId, "content_brief.json"))) {
            const brief = JSON.parse(readFileSync(jobPath(jobId, "content_brief.json"), "utf-8"));
            context = [userDescription, subtitleGlossaryFromBrief(brief)].filter(Boolean).join("\n");
          }
        } catch {}
        const prompt = buildChineseSubtitleTranslatePrompt({ ...request, context });
        const startedAt = Date.now();
        try {
          const output = await runGrokProcess({
            prompt,
            model,
            cwd: jobDir(jobId),
            reasoningEffort: "medium",
            timeoutMs: 6 * 60 * 1000,
            sandboxMode: "read-only",
            networkAccess: false,
            outputSchema: SUBTITLE_CUES_SCHEMA,
            outputFile,
            onSpawn: child => { controller.child = child; },
          });
          controller.child = null;
          if (controller.cancelled) throw new Error("任务已取消");
          if (output.code !== 0) throw new Error(conciseAgentError(output));
          if (!existsSync(outputFile)) throw new Error("模型未生成字幕译文");
          appendCallTrace(jobDir(jobId), {
            stage: "subtitles",
            attempt,
            model,
            ok: true,
            durationMs: Date.now() - startedAt,
            promptChars: prompt.length,
            imageCount: 0,
            outputFile,
          });
          return parseJsonReply(outputFile);
        } catch (error: any) {
          appendCallTrace(jobDir(jobId), {
            stage: "subtitles",
            attempt,
            model,
            ok: false,
            durationMs: Date.now() - startedAt,
            promptChars: prompt.length,
            imageCount: 0,
            outputFile,
            error: error?.message || String(error),
          });
          throw error;
        }
      };
      try {
        return await runTranslate(PRIMARY_AGENT_MODEL, 1);
      } catch {
        return await runTranslate(FALLBACK_AGENT_MODEL, 2);
      }
    },
  });
  controller.child = null;
  if (controller.cancelled) return null;
  emitJobStage(jobId, { stage: "subtitles", status: "completed", message: "中文字幕已烧进成片" });
  return {
    videoFile: safeJobAsset(jobId, burned.videoFile, "视频"),
    subtitleFile: burned.subtitleFile,
  };
}

async function runSimplifiedProcessing(
  jobId: string,
  url: string,
  userDescription: string,
  controller: any,
  options: { skipPrepare?: boolean } = {},
) {
  let lastError = "视频准备失败";
  try {
    if (options.skipPrepare) {
      if (!existsSync(jobPath(jobId, "prepare_result.json"))) throw new Error("没有可继续的视频准备结果");
      emitJobStage(jobId, { stage: "prepare", status: "skipped", message: "沿用已下载视频和封面" });
    } else {
      emitJobStage(jobId, { stage: "prepare", status: "started", message: "正在下载视频并截取分析帧" });
      const preparedOutput = await runVideoPrepare(jobId, url, controller);
      if (controller.cancelled) return;
      if (preparedOutput.code !== 0) {
        lastError = concisePrepareError(preparedOutput.stderr, preparedOutput.timedOut);
        emitJobStage(jobId, { stage: "prepare", status: "failed", message: lastError });
        controller.exitCode = 1;
        controller.lastError = lastError;
        return;
      }
      emitJobStage(jobId, { stage: "prepare", status: "completed", message: "视频准备完成" });
    }

    const prepared = JSON.parse(readFileSync(jobPath(jobId, "prepare_result.json"), "utf-8"));
    const downloadNote = String(prepared?.source?.download_note || "").trim();
    const screenshots = Array.isArray(prepared.screenshots)
      ? prepared.screenshots.slice(0, 3).map((path: unknown) => safeJobAsset(jobId, path, "封面"))
      : [];
    if (screenshots.length !== 3) throw new Error("本地程序未生成3张封面");
    const analysisFrames = Array.isArray(prepared.analysis_frames)
      ? prepared.analysis_frames.map((frame: any, index: number) => ({
        ...frame,
        path: safeJobAsset(jobId, frame?.path, `分析帧${index + 1}`),
      }))
      : [];
    if (analysisFrames.length !== 10) throw new Error("本地程序未生成完整的10张分析帧");
    let videoFile = safeJobAsset(jobId, prepared.video_file, "视频");
    const sourceVideoFile = videoFile;

    let transcriptInput = { ...prepared };
    if (prepared.transcript_file) {
      try {
        transcriptInput.transcript_file = safeJobAsset(jobId, prepared.transcript_file, "转写");
      } catch (error: any) {
        console.error(`[${jobId}][transcript] ${error.message}`);
        transcriptInput.transcript_file = "";
      }
    }
    const transcript = loadTranscript(transcriptInput);
    let subtitleFile = "";
    const shouldBurn = userRequestedChineseSubtitles(userDescription, readBurnSubtitlesFlag(jobId));
    const transcriptReady = transcript.status === "ready" && Array.isArray(transcript.segments) && transcript.segments.length > 0;
    if (shouldBurn && !transcriptReady) {
      if (userExplicitlyRequestedChineseSubtitles(userDescription)) {
        throw new Error("你要求添加中文字幕，但没有可用的语音转写");
      }
      emitJobStage(jobId, { stage: "subtitles", status: "skipped", message: "没有可用转写，跳过中文字幕" });
    } else if (shouldBurn) {
      const burned = await applyChineseSubtitles({
        jobId,
        controller,
        userDescription,
        transcript,
        sourceVideoFile,
      });
      if (controller.cancelled) return;
      if (burned) {
        videoFile = burned.videoFile;
        subtitleFile = burned.subtitleFile;
      }
    }
    const preparedForPipeline = {
      ...prepared,
      video_file: videoFile,
      screenshots,
      analysis_frames: analysisFrames,
      transcript_file: transcriptInput.transcript_file || "",
      transcript_status: transcript.status,
      has_speech: transcript.has_speech,
    };
    let modelCallIndex = 0;
    const runModel = async (request: MetadataModelRequest): Promise<unknown> => {
      if (controller.cancelled) throw new Error("任务已取消");
      modelCallIndex += 1;
      controller.model = request.model;
      const stageLabel = request.stage === "analysis"
        ? "正在分析完整视频证据"
        : request.stage === "draft"
          ? (request.attempt === 1 ? "正在生成证据化标题和简介" : "正在按审稿意见重写一次")
          : (request.attempt === 1 ? "正在独立审稿" : "正在复审重写文案");
      const percent = request.stage === "analysis" ? 68 : request.stage === "draft" ? (request.attempt === 1 ? 78 : 91) : (request.attempt === 1 ? 86 : 96);
      updateProgress(jobId, 4, 5, stageLabel, percent);
      emitJobStage(jobId, {
        stage: request.stage,
        status: "started",
        message: stageLabel,
        attempt: request.attempt,
        model: request.model,
      });
      const outputFile = jobPath(jobId, `_metadata_pipeline_${request.stage}_${request.attempt}_${modelCallIndex}.json`);
      const startedAt = Date.now();
      try { unlinkSync(outputFile); } catch {}
      try {
        const output = await runGrokProcess({
          prompt: request.prompt,
          model: request.model,
          cwd: jobDir(jobId),
          reasoningEffort: request.reasoningEffort,
          timeoutMs: request.stage === "analysis" ? 8 * 60 * 1000 : 6 * 60 * 1000,
          sandboxMode: "read-only",
          networkAccess: false,
          images: request.images,
          outputSchema: request.outputSchema,
          outputFile,
          onSpawn: child => { controller.child = child; },
        });
        controller.child = null;
        if (controller.cancelled) throw new Error("任务已取消");
        if (output.code !== 0) throw new Error(conciseAgentError(output));
        if (!existsSync(outputFile)) throw new Error("模型未生成结构化JSON");
        appendCallTrace(jobDir(jobId), {
          stage: request.stage,
          attempt: request.attempt,
          model: request.model,
          ok: true,
          durationMs: Date.now() - startedAt,
          promptChars: request.prompt.length,
          imageCount: request.images.length,
          outputFile,
        });
        emitJobStage(jobId, {
          stage: request.stage,
          status: "completed",
          message: stageLabel,
          attempt: request.attempt,
          model: request.model,
        });
        return parseJsonReply(outputFile);
      } catch (error: any) {
        appendCallTrace(jobDir(jobId), {
          stage: request.stage,
          attempt: request.attempt,
          model: request.model,
          ok: false,
          durationMs: Date.now() - startedAt,
          promptChars: request.prompt.length,
          imageCount: request.images.length,
          outputFile,
          error: error?.message || String(error),
        });
        emitJobStage(jobId, {
          stage: request.stage,
          status: "failed",
          message: error?.message || String(error),
          attempt: request.attempt,
          model: request.model,
        });
        throw error;
      } finally {
        controller.child = null;
      }
    };

    const pipeline = await runMetadataPipeline({
      prepared: preparedForPipeline,
      transcript,
      userDescription,
      artifactDir: jobDir(jobId),
      primaryModel: PRIMARY_AGENT_MODEL,
      fallbackModel: FALLBACK_AGENT_MODEL,
      schemas: {
        contentBrief: CONTENT_BRIEF_SCHEMA,
        metadata: METADATA_SCHEMA,
        review: METADATA_REVIEW_SCHEMA,
      },
      runModel,
      isCancelled: () => controller.cancelled,
      resumeFromBrief: true,
      lookupEntities: async (brief) => {
        const existing = jobPath(jobId, "lookup_results.json");
        if (existsSync(existing)) {
          try {
            const hits = JSON.parse(readFileSync(existing, "utf-8"));
            if (Array.isArray(hits)) return hits;
          } catch {}
        }
        return lookupEntities(brief);
      },
      onStage: (event) => emitJobStage(jobId, event),
      subtitleFile,
    });
    if (controller.cancelled) return;
    const resultIssues = assessJobResult(jobId);
    if (resultIssues.length > 0) throw new Error(`最终结果质量检查未通过：${resultIssues.join("；")}`);
    if (downloadNote) {
      const result = readJobResult(jobId);
      result.download_note = downloadNote;
      persistJobResult(jobId, result);
    }
    persistJobApprovals(jobId);
    emitJobStage(jobId, { stage: "complete", status: "completed", message: "处理完成" });
    updateProgress(
      jobId,
      5,
      5,
      pipeline.copyStatus === "approved" ? "处理完成，请确认待办项后保存草稿" : "文案需要人工检查，请修改并确认后再保存草稿",
      100,
    );
    controller.exitCode = 0;
    controller.lastError = "";
    return;
  } catch (error: any) {
    if (controller.cancelled) return;
    lastError = error.message || String(error);
    controller.exitCode = 1;
    controller.lastError = lastError;
  } finally {
    activeAgentJobs.delete(jobId);
  }
}

// 轮询Grok输出文件并推送进度
async function pollAgentProgress(jobId: string, proc: any) {
  const maxWait = MAX_AGENT_TIME_MS;
  const startTime = Date.now();
  let lastPercent = -1;
  let lastMessage = "";

  while (Date.now() - startTime < maxWait) {
    try {
      // 读取progress.json
      const progressPath = jobPath(jobId, "progress.json");
      if (existsSync(progressPath)) {
        const content = readFileSync(progressPath, "utf-8");
        const progress = JSON.parse(content);
        if (progress.percent !== lastPercent || progress.message !== lastMessage) {
          lastPercent = progress.percent;
          lastMessage = progress.message;
          broadcast({ type: "progress", ...progress }, jobId);
        }
      }

      // 检查result.json是否已生成（处理完成）
      const resultPath = jobPath(jobId, "result.json");
      if (proc.exitCode === 0 && existsSync(resultPath)) {
        const result = JSON.parse(readFileSync(resultPath, "utf-8"));
        broadcast({ type: "result", data: result }, jobId);
        return result;
      }
    } catch { /* 文件还不存在或不合法 */ }

    if (proc.exitCode !== null || proc.signalCode) {
      const message = proc.lastError || `处理程序提前退出(code=${proc.exitCode ?? "signal"})，未生成合格结果`;
      updateProgress(jobId, 0, 5, message, 0);
      broadcast({ type: "error", message }, jobId);
      return null;
    }

    await Bun.sleep(2000); // 2秒轮询
  }

  try {
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (proc.exitCode === null) try { proc.kill("SIGKILL"); } catch {}
    }, 5000);
  } catch {}
  updateProgress(jobId, 0, 5, "处理超时，进程已终止", 0);
  broadcast({ type: "error", message: `处理超时(${Math.round(MAX_AGENT_TIME_MS / 60000)}分钟)，进程已终止` }, jobId);
  return null;
}

// 创建Job目录
function createJobDir(): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const jobId = crypto.randomUUID().slice(0, 8);
    const directory = jobDir(jobId);
    if (existsSync(directory)) continue;
    mkdirSync(directory);
    mkdirSync(jobPath(jobId, "screenshots"));
    writeFileSync(jobPath(jobId, "progress.json"), JSON.stringify({ step: 0, total: 5, message: "等待开始...", percent: 0 }));
    return jobId;
  }
  throw new Error("无法创建唯一任务目录，请重试");
}

// 处理URL提交
async function handleSubmit(url: string, options: {
  userDescription?: string;
  burnChineseSubtitles?: boolean;
}): Promise<string> {
  if (activeAgentJobs.size >= MAX_CONCURRENT_AGENTS) {
    throw new Error(`当前已有${activeAgentJobs.size}个处理任务，请等待完成后再提交`);
  }
  const jobId = createJobDir();
  const userDescription = options.userDescription || "";
  const burnChineseSubtitles = userRequestedChineseSubtitles(userDescription, options.burnChineseSubtitles);

  updateProgress(jobId, 0, 5, "准备处理...", 0);
  writeFileSync(jobPath(jobId, "request.json"), JSON.stringify({
    url,
    description: userDescription,
    burnChineseSubtitles,
    mode: "simple",
  }, null, 2));

  console.log(`[${jobId}] Starting simplified local preparation...`);

  const controller: any = newJobController();
  activeAgentJobs.set(jobId, controller);

  void runSimplifiedProcessing(jobId, url, userDescription, controller).catch((err: any) => {
    controller.exitCode = 1;
    controller.lastError = `处理失败: ${err.message}`;
    activeAgentJobs.delete(jobId);
  });

  void pollAgentProgress(jobId, controller).then(result => {
    console.log(`[${jobId}] Simplified processing completed, model=${controller.model}, result=${!!result}`);
  });

  return jobId;
}

async function handleContinue(jobId: string): Promise<string> {
  const safeJobId = validateJobId(jobId);
  if (activeAgentJobs.has(safeJobId)) throw new Error("该任务正在处理");
  if (activeAgentJobs.size >= MAX_CONCURRENT_AGENTS) {
    throw new Error(`当前已有${activeAgentJobs.size}个处理任务，请等待完成后再继续`);
  }
  const hasPrepared = existsSync(jobPath(safeJobId, "prepare_result.json"));
  const hasRequest = existsSync(jobPath(safeJobId, "request.json"));
  if (!hasPrepared && !hasRequest) {
    throw new Error("没有可继续的视频准备结果");
  }
  if (existsSync(jobPath(safeJobId, "result.json"))) {
    throw new Error("文案已生成。若要换标题请用聊天或「试一组标题」，不要整单重跑");
  }
  let url = "";
  let userDescription = "";
  try {
    const request = JSON.parse(readFileSync(jobPath(safeJobId, "request.json"), "utf-8"));
    url = String(request.url || "");
    userDescription = String(request.description || "");
  } catch {}
  if (!hasPrepared && !url) {
    throw new Error("没有可继续的视频准备结果");
  }
  const controller: any = {
    child: null,
    exitCode: null,
    signalCode: null,
    cancelled: false,
    lastError: "",
    model: PRIMARY_AGENT_MODEL,
    kill(signal = "SIGTERM") {
      this.cancelled = true;
      this.signalCode = signal;
      if (this.child) try { this.child.kill(signal); } catch {}
    },
  };
  activeAgentJobs.set(safeJobId, controller);
  updateProgress(
    safeJobId,
    hasPrepared ? 4 : 1,
    5,
    hasPrepared
      ? (canResumeFromBrief(jobDir(safeJobId)) ? "从事实卡继续生成文案..." : "视频已就绪，继续生成文案...")
      : "正在重新下载视频",
    hasPrepared ? 60 : 15,
  );
  void runSimplifiedProcessing(safeJobId, url, userDescription, controller, { skipPrepare: hasPrepared }).catch((err: any) => {
    controller.exitCode = 1;
    controller.lastError = `处理失败: ${err.message}`;
    activeAgentJobs.delete(safeJobId);
  });
  void pollAgentProgress(safeJobId, controller);
  return safeJobId;
}

async function handleBurnSubtitles(jobId: string): Promise<string> {
  const safeJobId = validateJobId(jobId);
  if (activeAgentJobs.has(safeJobId)) throw new Error("该任务正在处理");
  if (activeAgentJobs.size >= MAX_CONCURRENT_AGENTS) {
    throw new Error(`当前已有${activeAgentJobs.size}个处理任务，请等待完成后再补烧字幕`);
  }
  if (!existsSync(jobPath(safeJobId, "prepare_result.json"))) {
    throw new Error("没有可烧字幕的视频准备结果");
  }
  if (!existsSync(jobPath(safeJobId, "result.json"))) {
    throw new Error("请先完成文案后再补烧字幕");
  }
  const prepared = JSON.parse(readFileSync(jobPath(safeJobId, "prepare_result.json"), "utf-8"));
  const sourceVideoFile = safeJobAsset(safeJobId, prepared.video_file, "视频");
  let transcriptInput = { ...prepared };
  if (prepared.transcript_file) {
    try {
      transcriptInput.transcript_file = safeJobAsset(safeJobId, prepared.transcript_file, "转写");
    } catch {
      transcriptInput.transcript_file = "";
    }
  }
  const transcript = loadTranscript(transcriptInput);
  if (transcript.status !== "ready" || !Array.isArray(transcript.segments) || transcript.segments.length === 0) {
    throw new Error("没有可用的语音转写，无法补烧中文字幕");
  }
  let userDescription = "";
  try {
    const request = JSON.parse(readFileSync(jobPath(safeJobId, "request.json"), "utf-8"));
    userDescription = String(request.description || "");
  } catch {}
  const controller: any = newJobController();
  activeAgentJobs.set(safeJobId, controller);
  updateProgress(safeJobId, 3, 5, "正在补烧中文字幕", 58);
  void (async () => {
    try {
      const burned = await applyChineseSubtitles({
        jobId: safeJobId,
        controller,
        userDescription,
        transcript,
        sourceVideoFile,
      });
      if (controller.cancelled) return;
      if (!burned) throw new Error("字幕烧录未完成");
      if (existsSync(jobPath(safeJobId, "result.json"))) {
        const result = readJobResult(safeJobId);
        result.video_file = burned.videoFile;
        result.subtitle_file = burned.subtitleFile;
        persistJobResult(safeJobId, result);
        persistJobApprovals(safeJobId);
        broadcastUpdatedResult(safeJobId);
      }
      updateProgress(safeJobId, 5, 5, "中文字幕已烧进成片", 100);
      controller.exitCode = 0;
      controller.lastError = "";
    } catch (error: any) {
      if (controller.cancelled) return;
      controller.exitCode = 1;
      controller.lastError = error?.message || String(error);
      updateProgress(safeJobId, 0, 5, controller.lastError, 0);
      broadcast({ type: "error", message: controller.lastError }, safeJobId);
    } finally {
      activeAgentJobs.delete(safeJobId);
    }
  })();
  void pollAgentProgress(safeJobId, controller);
  return safeJobId;
}

// API: 获取截图
function handleGetScreenshots(jobId: string): string[] {
  const ssDir = jobPath(jobId, "screenshots");
  try {
    return readdirSync(ssDir).filter(f => f.endsWith(".jpg") || f.endsWith(".png"))
      .map(f => join(ssDir, f));
  } catch { return []; }
}

// API: 确认投稿
async function handlePublish(jobId: string, data: {
  title: string;
  tags: string[];
  description: string;
  coverIndex?: number;
  coverPath?: string;
  tid?: number | string;
  topicId?: number | string;
  missionId?: number | string;
  postToChannels?: boolean;
}) {
  jobId = validateJobId(jobId);
  if (activePublishJobs.has(jobId)) {
    return { success: false, error: "该任务正在投稿，请勿重复提交" };
  }
  const pending = unacknowledgedApprovals(readApprovals(jobDir(jobId)).items);
  if (pending.length > 0) {
    return {
      success: false,
      error: `还有${pending.length}项未确认，确认后再保存草稿`,
      pending,
    };
  }

  const publishStatusPath = jobPath(jobId, "publish_status.json");
  if (existsSync(publishStatusPath)) {
    try {
      const previous = JSON.parse(readFileSync(publishStatusPath, "utf-8"));
      if (previous.state === "completed") {
        return { success: false, error: "该任务已经成功保存草稿，已阻止重复上传", aid: previous.aid || "" };
      }
      if (previous.state === "uploading") {
        return { success: false, error: "该任务上次上传状态不明确。请先检查B站草稿箱，确认没有草稿后再人工清除publish_status.json" };
      }
    } catch {}
  }

  // 读取result.json获取视频文件路径
  const result = readJobResult(jobId);
  const screenshotDir = jobPath(jobId, "screenshots");
  const tid = normalizeTid(data.tid ?? result.tid);

  // 封面文件：优先用前端传来的绝对路径，fallback到frame${index+1}.jpg
  let selectedCover: string;
  if (data.coverPath) {
    selectedCover = assertExistingFileInside(screenshotDir, data.coverPath, "封面");
    console.log(`[${jobId}] 封面(路径): ${selectedCover}`);
  } else {
    const coverIdx = data.coverIndex || 0;
    selectedCover = jobPath(jobId, "screenshots", `frame${coverIdx + 1}.jpg`);
    console.log(`[${jobId}] 封面(index=${coverIdx}): ${selectedCover}`);
  }
  // 校验封面文件存在
  if (!existsSync(selectedCover)) {
    console.error(`[${jobId}] ❌ 封面文件不存在: ${selectedCover}`);
    // fallback：尝试找screenshots目录下任意一个jpg
    const fallback = readdirSync(screenshotDir).filter(f => f.match(/^frame\d+\.jpg$/)).sort((a, b) =>
      parseInt(a.match(/(\d+)/)?.[0] || '0') - parseInt(b.match(/(\d+)/)?.[0] || '0')
    )[0];
    if (fallback) {
      selectedCover = join(screenshotDir, fallback);
      console.log(`[${jobId}] ⚠️ 封面fallback: ${selectedCover}`);
    } else {
      throw new Error("没有可用的封面文件");
    }
  }

  selectedCover = assertExistingFileInside(screenshotDir, selectedCover, "封面");

  if (!Array.isArray(data.tags) || data.tags.length < 1 || data.tags.length > 10) {
    throw new Error("标签数量必须为1到10个");
  }
  if (data.tags.some(tag => typeof tag !== "string" || !tag.trim() || tag.length > 20)) {
    throw new Error("标签必须是1到20字的文本");
  }
  if (typeof data.title !== "string" || !data.title.trim()) throw new Error("缺少标题");
  if (data.title.length > 80) throw new Error("标题不能超过80字");
  if (typeof data.description !== "string" || data.description.length > 2000) throw new Error("描述不能超过2000字");

  // 直接调用bili_upload_v2.py投稿；Grok没有投稿权限
  const { spawn } = require("child_process");
  const scriptPath = `${ROOT}/bili_upload_v2.py`;
  const pythonBin = "/opt/homebrew/Caskroom/miniforge/base/bin/python3";

  // 🔴 活动topic_id + mission_id：可选，不强制
  const hasTopicId = data.topicId !== undefined && data.topicId !== null && data.topicId !== "";
  const hasMissionId = data.missionId !== undefined && data.missionId !== null && data.missionId !== "";
  if (hasTopicId !== hasMissionId) throw new Error("活动topic_id和mission_id必须同时提供");
  const topicId = hasTopicId ? normalizePositiveInt(data.topicId, 1, 2_147_483_647) : undefined;
  const missionId = hasMissionId ? normalizePositiveInt(data.missionId, 1, 2_147_483_647) : undefined;
  const topicStr = topicId ? String(topicId) : undefined;
  console.log(`[${jobId}] 活动: topic=${topicStr || "无"}, mission=${missionId || "无"}`);

  // 🔴 多P支持：检查 result.video_files 或 split_segments
  const multiPart = result.is_multi_part && result.video_files && result.video_files.length > 1;

  const args: string[] = [
    scriptPath,
  ];
  let archiveSources: string[];
  if (multiPart) {
    const videoFiles = result.video_files.map((path: unknown) => safeJobAsset(jobId, path, "多P视频"));
    videoFiles.forEach((path: string) => {
      if (!existsSync(path)) throw new Error(`多P视频文件不存在: ${path}`);
    });
    archiveSources = videoFiles;
    args.push("--videos", ...videoFiles);
  } else {
    const videoFile = safeJobAsset(jobId, result.video_file || result.video_path, "视频");
    if (!existsSync(videoFile)) throw new Error("视频文件不存在");
    archiveSources = [videoFile];
    args.push("--video", videoFile);
  }
  const localArchive = saveSubmittedVideos({
    title: data.title,
    jobId,
    sources: archiveSources,
    destDir: localArchiveDir(),
  });
  args.push(
    "--title", data.title,
    "--tag", data.tags.join(","),
    "--desc", data.description || "",
    "--cover", selectedCover,
    "--tid", String(tid),
    "--draft",  // 默认存草稿
  );
  if (topicStr) {
    args.push("--topic", topicStr);
  }
  if (missionId) {
    args.push("--mission", String(missionId));
  }

  // 所有输入和文件都校验完成后再锁定任务，避免校验失败留下僵尸锁。
  activePublishJobs.add(jobId);
  broadcast({ type: "publishing", jobId }, jobId);
  updateProgress(jobId, 1, 2, "正在投稿到B站...", 50);
  const requestedActivity = topicId && missionId ? { topicId, missionId } : null;
  writeFileSync(publishStatusPath, JSON.stringify({
    state: "uploading",
    startedAt: new Date().toISOString(),
    activity: requestedActivity,
  }, null, 2));

  const child = spawn(pythonBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: "/Users/wangtangjie",  // 确保HOME正确
      http_proxy: "", https_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "",
      ALL_PROXY: "", all_proxy: "",  // 杀代理
    },
    cwd: WORKSPACE,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); console.log(`[${jobId}] upload: ${d.toString().trim()}`); });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); console.error(`[${jobId}] upload err: ${d.toString().trim()}`); });

  return new Promise((resolve) => {
    let finished = false;
    let timedOut = false;
    const uploadTimeout = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
    }, MAX_UPLOAD_TIME_MS);
    const finishOnce = () => {
      if (finished) return false;
      finished = true;
      clearTimeout(uploadTimeout);
      activePublishJobs.delete(jobId);
      return true;
    };
    child.on("close", (code: number) => {
      if (!finishOnce()) return;
      console.log(`[${jobId}] Upload script exited, code=${code}`);
      console.log(`[${jobId}] stdout: ${stdout.slice(-500)}`);
      console.log(`[${jobId}] stderr: ${stderr.slice(-500)}`);

      // 检查AID(草稿)或BV号(投稿)
      const aidMatch = stdout.match(/AID:(\d+)/);
      const bvidMatch = stdout.match(/BV[a-zA-Z0-9]+/);
      if (code === 0) {
        const aid = aidMatch?.[1];
        const bvid = bvidMatch?.[0];
        updateProgress(jobId, 2, 2, "草稿保存成功", 100);
        let channels: { requested: boolean; started: boolean; error?: string; pid?: number } = {
          requested: false,
          started: false,
        };
        if (channelsPostRequested(data.postToChannels)) {
          channels.requested = true;
          try {
            const started = startChannelsDraft({
              videoPath: localArchive.files[0],
              title: data.title,
              description: data.description || "",
              tags: data.tags,
            });
            channels = { requested: true, started: true, pid: started.pid };
          } catch (error: any) {
            channels = { requested: true, started: false, error: error?.message || String(error) };
          }
        }
        writeFileSync(publishStatusPath, JSON.stringify({
          state: "completed",
          completedAt: new Date().toISOString(),
          aid: aid || "",
          bvid: bvid || "",
          draft: true,
          activity: requestedActivity,
          localArchive,
          channels,
        }, null, 2));
        broadcast({ type: "published", bvid: bvid || "", aid: aid || "", jobId, draft: true, localArchive, channels }, jobId);
        resolve({ success: true, aid: aid || "", bvid: bvid || "", draft: true, activity: requestedActivity, localArchive, channels });
      } else {
        const errMsg = timedOut ? "投稿超过6小时，进程已终止" : (stderr.trim() || stdout.trim() || `投稿进程退出(code ${code})`);
        writeFileSync(publishStatusPath, JSON.stringify({ state: "failed", failedAt: new Date().toISOString(), error: errMsg.slice(-500), localArchive }, null, 2));
        broadcast({ type: "error", message: errMsg.slice(-200) }, jobId);
        resolve({ success: false, error: errMsg.slice(-300), localArchive });
      }
    });

    child.on("error", (err: any) => {
      if (!finishOnce()) return;
      writeFileSync(publishStatusPath, JSON.stringify({ state: "failed", failedAt: new Date().toISOString(), error: err.message }, null, 2));
      broadcast({ type: "error", message: `投稿失败: ${err.message}` }, jobId);
      resolve({ success: false, error: err.message });
    });
  });
}

function sendChatStream(clientId: string | undefined, text: string) {
  if (!clientId) return;
  const client = clients.get(clientId);
  if (client) try { client.ws.send(JSON.stringify({ type: "chat_stream", text })); } catch {}
}

function broadcastUpdatedResult(jobId: string) {
  try {
    const resultPath = jobPath(jobId, "result.json");
    if (!existsSync(resultPath)) return;
    const updated = JSON.parse(readFileSync(resultPath, "utf-8"));
    broadcast({ type: "result", data: updated }, jobId);
  } catch {}
}

function persistJobResult(jobId: string, result: unknown): void {
  const resultPath = jobPath(jobId, "result.json");
  const temporary = jobPath(jobId, ".result.json.tmp");
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(temporary, resultPath);
}

async function runCopyModel(input: {
  jobId: string;
  prompt: string;
  outputPrefix: string;
  clientId?: string;
}): Promise<unknown> {
  const models = [...new Set([PRIMARY_AGENT_MODEL, FALLBACK_AGENT_MODEL])];
  let lastError = "Grok未返回调整结果";
  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    const isFallback = index > 0;
    if (isFallback) sendChatStream(input.clientId, `\n常规模型未完成，切换 ${model} 复核…`);
    const outputFile = jobPath(input.jobId, `${input.outputPrefix}_${index}.json`);
    const startedAt = Date.now();
    try { unlinkSync(outputFile); } catch {}
    const attemptPrompt = isFallback
      ? `${input.prompt}\n\n上一轮失败原因：${lastError}。请只输出完整JSON。`
      : input.prompt;
    const output = await runGrokProcess({
      prompt: attemptPrompt,
      model,
      cwd: jobDir(input.jobId),
      timeoutMs: isFallback ? 5 * 60 * 1000 : 8 * 60 * 1000,
      reasoningEffort: isFallback ? "medium" : "high",
      outputFile,
    });
    appendCallTrace(jobDir(input.jobId), {
      stage: "chat",
      attempt: (index + 1) as 1 | 2,
      model,
      ok: output.code === 0,
      durationMs: Date.now() - startedAt,
      promptChars: attemptPrompt.length,
      imageCount: 0,
      outputFile,
      error: output.code === 0 ? undefined : conciseAgentError(output),
    });
    let raw = "";
    try { raw = readFileSync(outputFile, "utf-8").trim(); } catch {}
    if (output.code !== 0 || !raw) {
      lastError = conciseAgentError(output);
      continue;
    }
    try {
      return JSON.parse(raw);
    } catch {
      lastError = "Grok 返回的不是JSON";
    }
  }
  throw new Error(lastError);
}

// Chat: 同一任务下一轮，带着事实卡改稿，通过质量门后才写回 result.json
async function handleChat(message: string, jobId?: string, clientId?: string): Promise<{ reply: string; result?: unknown }> {
  if (typeof message !== "string" || !message.trim()) throw new Error("消息不能为空");
  if (message.length > MAX_CHAT_MESSAGE_LENGTH) throw new Error(`消息不能超过${MAX_CHAT_MESSAGE_LENGTH}字`);
  const safeJobId = validateJobId(jobId);
  const directory = jobDir(safeJobId);
  if (!existsSync(directory)) throw new Error("Job不存在");
  if (activeChatJobs.has(safeJobId)) throw new Error("该任务已有调整正在进行，请稍候");
  const resultPath = jobPath(safeJobId, "result.json");
  if (!existsSync(resultPath)) throw new Error("当前任务还没有可调整的文案，请等处理完成");
  const brief = readPersistedBrief(directory);
  if (!brief) throw new Error("缺少事实卡，无法安全改稿");

  const current = readJobResult(safeJobId);
  const prompt = buildChatTurnPrompt({ brief, result: current, message: message.trim() });
  activeChatJobs.add(safeJobId);
  sendChatStream(clientId, `正在使用 ${PRIMARY_AGENT_MODEL} 按事实卡调整文案…`);
  try {
    const parsed = await runCopyModel({
      jobId: safeJobId,
      prompt,
      outputPrefix: "_grok_chat",
      clientId,
    });
    const patch = chatPatchFromModel(parsed);
    const outcome = applyChatTurn({ result: current, brief, patch });
    if (!outcome.accepted) {
      return {
        reply: patch.reply
          ? `${patch.reply}\n未写入：${outcome.hardIssues.join("；")}`
          : `未写入，因为改稿触碰了禁止断言：${outcome.hardIssues.join("；")}`,
        result: current,
      };
    }
    if (outcome.changed.length > 0) {
      persistJobResult(safeJobId, outcome.result);
      persistJobApprovals(safeJobId);
      broadcastUpdatedResult(safeJobId);
      broadcast({ type: "approvals", items: readApprovals(directory).items }, safeJobId);
    }
    const reply = patch.reply
      || (outcome.changed.length > 0 ? `已更新：${outcome.changed.join("、")}` : "没有需要改的文案");
    const gateNote = outcome.issues.length > 0 ? `\n质量门：${outcome.issues.slice(0, 3).join("；")}` : "";
    return { reply: `${reply}${gateNote}`, result: outcome.changed.length > 0 ? outcome.result : current };
  } finally {
    activeChatJobs.delete(safeJobId);
  }
}

async function handleTitleBranch(jobId: string, message: string, clientId?: string) {
  const safeJobId = validateJobId(jobId);
  const directory = jobDir(safeJobId);
  const brief = readPersistedBrief(directory);
  if (!brief) throw new Error("缺少事实卡，无法试验标题");
  const current = readJobResult(safeJobId);
  const prompt = buildChatTurnPrompt({
    brief,
    result: current,
    message: message.trim() || "在不改变事实的前提下，给出另一组五个具体标题，卖点不要和当前这组重复。",
  });
  const parsed = await runCopyModel({
    jobId: safeJobId,
    prompt,
    outputPrefix: "_grok_branch",
    clientId,
  });
  const patch = chatPatchFromModel(parsed);
  const outcome = applyChatTurn({ result: current, brief, patch });
  if (!outcome.accepted) {
    throw new Error(`标题试验未通过质量门：${outcome.hardIssues.join("；")}`);
  }
  const branch = createTitleBranch(directory, {
    label: message.trim() || "标题试验",
    result: outcome.result,
    source: "chat",
  });
  return { branch: summarizeBranch(branch), reply: patch.reply || "已生成一组标题试验，当前文案未改动" };
}

function handleApplyBranch(jobId: string, branchId: string) {
  const safeJobId = validateJobId(jobId);
  const directory = jobDir(safeJobId);
  const brief = readPersistedBrief(directory);
  if (!brief) throw new Error("缺少事实卡");
  const branch = readTitleBranch(directory, branchId);
  persistJobResult(safeJobId, branch.result);
  persistJobApprovals(safeJobId);
  broadcastUpdatedResult(safeJobId);
  broadcast({ type: "approvals", items: readApprovals(directory).items }, safeJobId);
  return branch.result;
}

// API: 获取Job历史列表
function handleListJobs(): Array<{
  jobId: string;
  hasResult: boolean;
  hasBrief: boolean;
  hasPrepared: boolean;
  canContinue: boolean;
  hasVideo: boolean;
  videoSize: number;
  createdAt: string;
  title?: string;
}> {
  try {
    return readdirSync(WORKSPACE, { withFileTypes: true })
      .filter(d => {
        if (!d.isDirectory()) return false;
        try { validateJobId(d.name); return true; } catch { return false; }
      })
      .map(d => {
        const directory = jobDir(d.name);
        const hasResult = existsSync(jobPath(d.name, "result.json"));
        const hasBrief = canResumeFromBrief(directory);
        const hasPrepared = existsSync(jobPath(d.name, "prepare_result.json"));
        const hasRequest = existsSync(jobPath(d.name, "request.json"));
        const hasVideo = existsSync(jobPath(d.name, "output.mp4"));
        let videoSize = 0;
        let title = undefined;
        if (hasResult) {
          try {
            const result = readJobResult(d.name);
            title = result.title_candidates?.[0] || undefined;
          } catch {}
        }
        if (hasVideo) {
          try { videoSize = statSync(jobPath(d.name, "output.mp4")).size; } catch {}
        }
        let createdAt = new Date(0).toISOString();
        try {
          const stats = statSync(directory);
          createdAt = (stats.birthtimeMs > 0 ? stats.birthtime : stats.mtime).toISOString();
        } catch {}
        return {
          jobId: d.name,
          hasResult,
          hasBrief,
          hasPrepared,
          canContinue: jobCanContinue({ hasResult, hasBrief, hasPrepared, hasRequest }),
          hasVideo,
          videoSize,
          createdAt,
          title,
        };
      })
      .filter(j => jobIsListable(j))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50);
  } catch { return []; }
}

const CLEAN_ENV = {
  ...process.env,
  http_proxy: "", https_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", all_proxy: "",
};

async function runProcess(command: string, args: string[], timeoutMs: number) {
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", env: CLEAN_ENV });
  const timeout = setTimeout(() => { try { proc.kill("SIGTERM"); } catch {} }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
  }
}

function jobIsBusy(jobId: string): boolean {
  return activeAgentJobs.has(jobId) || activePublishJobs.has(jobId) || activeChatJobs.has(jobId) || activeMediaJobs.has(jobId);
}

function apiFailure(err: any, fallbackStatus = 400): Response {
  if (fallbackStatus >= 500) console.error(err);
  return jsonError(err?.message || "请求失败", fallbackStatus);
}

// HTTP Router
serve({
  hostname: HOSTNAME,
  port: PORT,
  maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
  websocket: {
    open(ws) {
      const clientId = crypto.randomUUID();
      ws.data = { clientId };
      clients.set(clientId, { ws, jobId: null });
      ws.send(JSON.stringify({ type: "connected", clientId }));
    },
    message(ws, data) {
      const clientId = (ws.data as any).clientId;
      try {
        const msg = JSON.parse(String(data));
        if (msg.type === "register_job") {
          const client = clients.get(clientId);
          if (client) client.jobId = validateJobId(msg.jobId);
          return;
        }
        if (msg.type === "chat") {
          const client = clients.get(clientId);
          const chatJobId = msg.jobId || client?.jobId;
          handleChat(msg.message, chatJobId, clientId).then(outcome => {
            const current = clients.get(clientId);
            if (current) current.ws.send(JSON.stringify({ type: "chat_reply", reply: outcome.reply }));
          }).catch(err => {
            const current = clients.get(clientId);
            if (current) current.ws.send(JSON.stringify({ type: "chat_error", error: err.message }));
          });
        }
      } catch (err: any) {
        try { ws.send(JSON.stringify({ type: "error", message: err.message || "消息格式错误" })); } catch {}
      }
    },
    close(ws) {
      const clientId = (ws.data as any)?.clientId;
      if (clientId) clients.delete(clientId);
    },
  },
  async fetch(req, server) {
    const url = new URL(req.url);

    if (!isTrustedHost(req.headers.get("host"), PORT)) return new Response("Misdirected Request", { status: 421 });

    if (url.pathname === "/api/health" && req.method === "GET") {
      return Response.json({
        status: "ok",
        service: "bili-publisher-grok-v2",
        port: PORT,
        authRequired: true,
        driver: "grok",
        edition: "harness-patterns",
        grokRole: "metadata-only",
        models: { primary: PRIMARY_AGENT_MODEL, fallback: FALLBACK_AGENT_MODEL },
        grokAuth: grokAuthStatus(),
        localArchiveDir: localArchiveDir(),
        channelsPostDefault: false,
        active: { processing: activeAgentJobs.size, publishing: activePublishJobs.size },
      });
    }

    if (url.pathname === "/" && req.method === "GET" && url.searchParams.has("token")) {
      if (!tokenMatches(url.searchParams.get("token") || undefined)) return new Response("Unauthorized", { status: 401 });
      return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": authCookieHeader(), "Cache-Control": "no-store" } });
    }

    // 首页只在回环地址开放，并自动建立本机HttpOnly会话。这样误开file://页面时也能安全跳回服务页。
    if (url.pathname === "/" && req.method === "GET") {
      const headers: Record<string, string> = {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
      };
      if (!isAuthorized(req)) headers["Set-Cookie"] = authCookieHeader();
      return new Response(Bun.file(join(ROOT, "public", "index.html")), { headers });
    }

    const authorized = isAuthorized(req);
    const helperResponse = uiHelpersResponse(req, url, ROOT, authorized);
    if (helperResponse) return helperResponse;
    if (!authorized) return new Response("Unauthorized", { status: 401 });

    if (!isMutationRequestAllowed(req, PORT)) return jsonError("已拒绝跨站修改请求", 403);

    if (url.pathname === "/ws") {
      const success = server.upgrade(req, { data: {} });
      if (!success) return new Response("WebSocket upgrade failed", { status: 500 });
      return;
    }

    if (url.pathname === "/api/jobs" && req.method === "GET") {
      return Response.json({ jobs: handleListJobs() });
    }

    if (url.pathname === "/api/submit" && req.method === "POST") {
      try {
        const body = await req.json();
        const sourceUrl = extractSourceUrl(body.url);
        const description = body.description === undefined ? "" : String(body.description);
        if (description.length > 2000) throw new Error("补充说明不能超过2000字");
        const burnChineseSubtitles = typeof body.burnChineseSubtitles === "boolean"
          ? body.burnChineseSubtitles
          : undefined;
        const jobId = await handleSubmit(sourceUrl, { userDescription: description, burnChineseSubtitles });
        return Response.json({ success: true, jobId });
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/result" && req.method === "GET") {
      try {
        const requestedJobId = validateJobId(url.searchParams.get("jobId"));
        const resultPath = jobPath(requestedJobId, "result.json");
        if (!existsSync(resultPath)) return jsonError("结果未就绪", 404);
        return Response.json(readJobResult(requestedJobId));
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/continue" && req.method === "POST") {
      try {
        const body = await req.json();
        const continued = await handleContinue(body.jobId);
        return Response.json({ success: true, jobId: continued });
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/burn-subtitles" && req.method === "POST") {
      try {
        const body = await req.json();
        const burned = await handleBurnSubtitles(body.jobId);
        return Response.json({ success: true, jobId: burned });
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      try {
        const requestedJobId = validateJobId(url.searchParams.get("jobId"));
        return Response.json({ events: readStageEvents(jobDir(requestedJobId)) });
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/traces" && req.method === "GET") {
      try {
        const requestedJobId = validateJobId(url.searchParams.get("jobId"));
        return Response.json({ traces: readCallTraces(jobDir(requestedJobId)) });
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/approvals" && req.method === "GET") {
      try {
        const requestedJobId = validateJobId(url.searchParams.get("jobId"));
        return Response.json(readApprovals(jobDir(requestedJobId)));
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/approvals" && req.method === "POST") {
      try {
        const body = await req.json();
        const requestedJobId = validateJobId(body.jobId);
        const ids = Array.isArray(body.ids) ? body.ids.map((id: unknown) => String(id)) : [];
        if (ids.length === 0) throw new Error("缺少确认项");
        const state = acknowledgeApprovals(jobDir(requestedJobId), ids);
        broadcast({ type: "approvals", items: state.items }, requestedJobId);
        return Response.json({ success: true, ...state });
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/branches" && req.method === "GET") {
      try {
        const requestedJobId = validateJobId(url.searchParams.get("jobId"));
        return Response.json({
          branches: listTitleBranches(jobDir(requestedJobId)).map(summarizeBranch),
        });
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/branches" && req.method === "POST") {
      try {
        const body = await req.json();
        const requestedJobId = validateJobId(body.jobId);
        const message = body.message === undefined ? "" : String(body.message);
        if (message.length > MAX_CHAT_MESSAGE_LENGTH) throw new Error(`消息不能超过${MAX_CHAT_MESSAGE_LENGTH}字`);
        const outcome = await handleTitleBranch(requestedJobId, message);
        return Response.json({ success: true, ...outcome });
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/branches/apply" && req.method === "POST") {
      try {
        const body = await req.json();
        const requestedJobId = validateJobId(body.jobId);
        const result = handleApplyBranch(requestedJobId, String(body.branchId || ""));
        return Response.json({ success: true, result });
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/progress" && req.method === "GET") {
      try {
        const requestedJobId = validateJobId(url.searchParams.get("jobId"));
        const progressPath = jobPath(requestedJobId, "progress.json");
        if (!existsSync(progressPath)) return Response.json({ step: 0, total: 5, message: "等待开始...", percent: 0 });
        return Response.json(JSON.parse(readFileSync(progressPath, "utf-8")));
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/screenshots" && req.method === "GET") {
      try {
        const requestedJobId = validateJobId(url.searchParams.get("jobId"));
        return Response.json({ screenshots: handleGetScreenshots(requestedJobId) });
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/publish" && req.method === "POST") {
      try {
        const body = await req.json();
        if (!body.jobId || !body.title || !Array.isArray(body.tags)) throw new Error("缺少必要参数");
        const result = await handlePublish(body.jobId, {
          title: body.title, tags: body.tags, description: body.description, coverIndex: body.coverIndex,
          coverPath: body.coverPath, tid: body.tid, topicId: body.topicId, missionId: body.missionId,
          postToChannels: body.postToChannels === true,
        });
        return Response.json(result, { status: result.success ? 200 : 409 });
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      try {
        const body = await req.json();
        const outcome = await handleChat(body.message, body.jobId);
        return Response.json({ success: true, reply: outcome.reply, result: outcome.result });
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/cleanup" && req.method === "POST") {
      try {
        const body = await req.json();
        const requestedJobId = validateJobId(body.jobId);
        if (body.confirmJobId !== requestedJobId) throw new Error("删除确认不匹配");
        if (jobIsBusy(requestedJobId)) return jsonError("任务正在运行，不能删除", 409);
        const directory = jobDir(requestedJobId);
        if (!existsSync(directory)) return jsonError("Job不存在", 404);
        rmSync(directory, { recursive: true, force: false });
        return Response.json({ success: true });
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/download" && req.method === "POST") {
      try {
        const body = await req.json();
        const requestedJobId = validateJobId(body.jobId);
        const result = readJobResult(requestedJobId);
        let srcFile = safeJobAsset(requestedJobId, result.video_file, "视频");
        if (!existsSync(srcFile)) return jsonError("视频文件不存在", 404);
        const probe = await runProcess("/opt/homebrew/Caskroom/miniforge/base/bin/ffprobe", [
          "-v", "error", "-show_entries", "format=format_name", "-of", "json", srcFile,
        ], 15_000);
        if (probe.exitCode !== 0) {
          const rawVideo = jobPath(requestedJobId, "video.mp4");
          if (!existsSync(rawVideo)) return jsonError("视频文件损坏", 422);
          srcFile = rawVideo;
        }
        const safeTitle = String(result.title_candidates?.[0] || "video").replace(/[\/\\:*?"<>|]/g, "_").slice(0, 40);
        const destination = join("/Users/wangtangjie/Desktop", `${safeTitle}_${requestedJobId}.mp4`);
        copyFileSync(srcFile, destination);
        return Response.json({ success: true, path: destination });
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/rescreenshot" && req.method === "POST") {
      let requestedJobId = "";
      try {
        const body = await req.json();
        requestedJobId = validateJobId(body.jobId);
        if (jobIsBusy(requestedJobId)) return jsonError("任务正在运行，请稍候", 409);
        const numShots = normalizePositiveInt(body.count, 8, 32);
        const result = readJobResult(requestedJobId);
        const videoFile = safeJobAsset(requestedJobId, result.video_file, "视频");
        if (!existsSync(videoFile)) return jsonError("视频文件不存在", 404);
        const screenshotDir = jobPath(requestedJobId, "screenshots");
        const revisionFile = join(screenshotDir, ".rescreenshot.json");
        let previousRevision = 0;
        try {
          const savedRevision = Number(JSON.parse(readFileSync(revisionFile, "utf-8")).revision);
          if (Number.isInteger(savedRevision) && savedRevision > 0) previousRevision = savedRevision;
        } catch {}

        activeMediaJobs.add(requestedJobId);

        const probe = await runProcess("/opt/homebrew/Caskroom/miniforge/base/bin/ffprobe", [
          "-v", "error", "-show_entries", "format=duration", "-of", "json", videoFile,
        ], 15_000);
        if (probe.exitCode !== 0) return jsonError("无法读取视频时长", 422);
        const duration = Number(JSON.parse(probe.stdout).format.duration);
        if (!Number.isFinite(duration) || duration <= 0) return jsonError("视频时长无效", 422);

        const revision = previousRevision + 1;
        const timestamps = buildRescreenshotTimestamps(duration, numShots, revision);
        const stagingDir = jobPath(requestedJobId, `.screenshots-${randomBytes(8).toString("hex")}`);
        mkdirSync(stagingDir, { recursive: false });
        try {
          for (let index = 0; index < timestamps.length; index++) {
            const output = join(stagingDir, `frame${index + 1}.jpg`);
            const proc = await runProcess("/opt/homebrew/Caskroom/miniforge/base/bin/ffmpeg", [
              "-ss", timestamps[index].toFixed(6), "-i", videoFile,
              "-frames:v", "1", "-q:v", "2", "-y", output,
            ], 60_000);
            if (proc.exitCode !== 0) {
              throw new Error(proc.stderr.slice(-300) || `第${index + 1}张封面截取失败`);
            }
          }
          writeFileSync(join(stagingDir, ".rescreenshot.json"), JSON.stringify({ revision, timestamps }, null, 2));
          rmSync(screenshotDir, { recursive: true, force: true });
          renameSync(stagingDir, screenshotDir);
        } catch (err) {
          rmSync(stagingDir, { recursive: true, force: true });
          throw err;
        }

        const screenshots = handleGetScreenshots(requestedJobId);
        result.screenshots = screenshots;
        writeFileSync(jobPath(requestedJobId, "result.json"), JSON.stringify(result, null, 2));
        return Response.json({ success: true, screenshots, revision });
      } catch (err) { return apiFailure(err); }
      finally { if (requestedJobId) activeMediaJobs.delete(requestedJobId); }
    }

    if (url.pathname === "/api/split" && req.method === "POST") {
      let requestedJobId = "";
      try {
        const body = await req.json();
        requestedJobId = validateJobId(body.jobId);
        if (jobIsBusy(requestedJobId)) return jsonError("任务正在运行，请稍候", 409);
        const resultPath = jobPath(requestedJobId, "result.json");
        if (!existsSync(resultPath)) return jsonError("Job结果文件不存在", 404);
        const result = readJobResult(requestedJobId);
        const videoFile = safeJobAsset(requestedJobId, result.video_file, "视频");
        if (!existsSync(videoFile)) return jsonError("视频文件不存在", 404);
        activeMediaJobs.add(requestedJobId);

        const probe = await runProcess("/opt/homebrew/Caskroom/miniforge/base/bin/ffprobe", [
          "-v", "error", "-show_entries", "format=duration", "-of", "json", videoFile,
        ], 15_000);
        if (probe.exitCode !== 0) return jsonError("无法读取视频时长", 422);
        const duration = Number(JSON.parse(probe.stdout).format.duration);
        const sortedPoints = normalizeSplitPoints(body.splitPoints, duration);
        if (sortedPoints.length === 0) throw new Error("至少需要一个分割点");

        const splitDir = jobPath(requestedJobId, "splits");
        rmSync(splitDir, { recursive: true, force: true });
        mkdirSync(splitDir, { recursive: true });
        const allPoints = [0, ...sortedPoints];
        const segments: { start: number; end: string; index: number; path: string }[] = [];
        for (let i = 0; i < allPoints.length; i++) {
          const start = allPoints[i];
          const end = i < allPoints.length - 1 ? allPoints[i + 1] : duration;
          const outputPath = jobPath(requestedJobId, "splits", `part${i + 1}.mp4`);
          const args = ["-y", "-i", videoFile, "-ss", String(start)];
          if (i < allPoints.length - 1) args.push("-to", String(end));
          args.push("-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "aac", "-movflags", "+faststart", outputPath);
          const splitProc = await runProcess("/opt/homebrew/Caskroom/miniforge/base/bin/ffmpeg", args, 5 * 60_000);
          if (splitProc.exitCode !== 0) return jsonError(`分段${i + 1}切割失败: ${splitProc.stderr.slice(-200)}`, 500);
          segments.push({ start, end: String(end), index: i + 1, path: outputPath });
        }
        result.split_segments = segments;
        result.video_files = segments.map(segment => segment.path);
        result.is_multi_part = true;
        writeFileSync(resultPath, JSON.stringify(result, null, 2));
        broadcast({ type: "result", data: result }, requestedJobId);
        return Response.json({ success: true, segments, video_files: result.video_files });
      } catch (err) { return apiFailure(err); }
      finally { if (requestedJobId) activeMediaJobs.delete(requestedJobId); }
    }

    if (url.pathname === "/api/videoinfo" && req.method === "GET") {
      try {
        const requestedJobId = validateJobId(url.searchParams.get("jobId"));
        const infoPath = jobPath(requestedJobId, "video_info.json");
        if (existsSync(infoPath)) return Response.json(JSON.parse(readFileSync(infoPath, "utf-8")));
        const result = readJobResult(requestedJobId);
        const videoFile = safeJobAsset(requestedJobId, result.video_file, "视频");
        if (!existsSync(videoFile)) return jsonError("视频文件不存在", 404);
        const probe = await runProcess("/opt/homebrew/Caskroom/miniforge/base/bin/ffprobe", [
          "-v", "error", "-show_entries", "format=duration,size:stream=width,height,codec_name", "-of", "json", videoFile,
        ], 15_000);
        if (probe.exitCode !== 0) return jsonError(probe.stderr.slice(-300) || "读取视频信息失败", 500);
        const info = JSON.parse(probe.stdout);
        writeFileSync(infoPath, JSON.stringify(info, null, 2));
        return Response.json(info);
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname === "/api/activities" && req.method === "GET") {
      try {
        const tid = normalizeTid(url.searchParams.get("tid"));
        const proc = await runProcess("/opt/homebrew/Caskroom/miniforge/base/bin/python3", [`${ROOT}/bili_activities.py`, String(tid)], 30_000);
        if (proc.exitCode !== 0) return jsonError(proc.stderr.slice(-300) || "活动查询失败", 502);
        const activities = JSON.parse(proc.stdout);
        return Response.json({ success: true, activities });
      } catch (err) { return apiFailure(err); }
    }

    if (url.pathname.startsWith("/workspace/") && req.method === "GET") {
      try {
        const parts = url.pathname.split("/").slice(2).map(decodeURIComponent);
        const requestedJobId = validateJobId(parts.shift());
        if (parts.length === 0) return new Response("Not found", { status: 404 });
        const candidatePath = jobPath(requestedJobId, ...parts);
        if (!ALLOWED_ASSET_EXTENSIONS.has(extname(candidatePath).toLowerCase())) return new Response("Forbidden", { status: 403 });
        const filePath = safeJobAsset(requestedJobId, candidatePath, "资源");
        const file = Bun.file(filePath);
        if (!await file.exists()) return new Response("Not found", { status: 404 });
        return new Response(file, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
      } catch { return new Response("Not found", { status: 404 }); }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`🎬 B站投稿助手(Grok)已启动: http://${HOSTNAME}:${PORT}`);
