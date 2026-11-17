import { spawn, spawnSync } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

export const SUBTITLE_FFMPEG = "/opt/homebrew/Caskroom/miniforge/base/bin/ffmpeg";
export const SUBTITLE_FFPROBE = "/opt/homebrew/Caskroom/miniforge/base/bin/ffprobe";
/** SRT 经 libass 包装后 PlayResY 固定为 288，字号和边距都按画面高度放大。 */
const ASS_PLAYRES_Y = 288;
export const SUBTITLE_BATCH_SIZE = 16;
export const SUBTITLE_SRT_NAME = "zh.srt";
export const SUBTITLE_VIDEO_NAME = "video_zh.mp4";

export interface TranscriptCue {
  start: number;
  end: number;
  text: string;
}

export interface IndexedCue extends TranscriptCue {
  index: number;
}

export interface TranslatedCue {
  index: number;
  text_zh: string;
}

export interface SubtitleTranslateRequest {
  batch: readonly IndexedCue[];
  script: readonly IndexedCue[];
  previousZh: readonly TranslatedCue[];
  upcoming: readonly IndexedCue[];
  context?: string;
}

export interface SubtitleCue extends TranscriptCue {
  text_zh: string;
}

const CJK_FONT_CANDIDATES = [
  { path: "/System/Library/Fonts/STHeiti Medium.ttc", name: "Heiti SC" },
  { path: "/System/Library/Fonts/STHeiti Light.ttc", name: "Heiti SC" },
  { path: "/System/Library/Fonts/Supplemental/Songti.ttc", name: "Songti SC" },
  { path: "/Library/Fonts/Arial Unicode.ttf", name: "Arial Unicode MS" },
] as const;

export function userRefusedChineseSubtitles(description: string): boolean {
  const text = String(description || "").normalize("NFKC").trim();
  return /(不要|不用|别加|无需|不需要|不要加|不加)\s*(?:中文|中英|双语)?字幕/.test(text);
}

export function userExplicitlyRequestedChineseSubtitles(description: string): boolean {
  const text = String(description || "").normalize("NFKC").trim();
  if (!text || userRefusedChineseSubtitles(text)) return false;
  if (/(中文字幕|中英字幕|中英双字|双语字幕|硬字幕|内嵌字幕)/.test(text)) return true;
  return /(添加|加上|加|烧录|烧|制作|生成|配)\s*(?:中文|中英|双语)?字幕/.test(text);
}

export function userRequestedChineseSubtitles(description: string, flag?: boolean | null): boolean {
  if (userRefusedChineseSubtitles(description)) return false;
  if (flag === false) return false;
  return true;
}

export function textLooksChinese(text: string): boolean {
  const letters = [...String(text || "")].filter(character => /\p{L}/u.test(character));
  if (letters.length === 0) return false;
  const han = letters.filter(character => /\p{Script=Han}/u.test(character));
  return han.length / letters.length >= 0.5;
}

export function transcriptNeedsTranslation(language: string, cues: readonly TranscriptCue[]): boolean {
  const normalized = String(language || "").trim().toLowerCase();
  if (normalized === "zh" || normalized.startsWith("zh-") || normalized === "chinese" || normalized === "cn") {
    return false;
  }
  const nonempty = cues.filter(cue => String(cue.text || "").trim());
  if (nonempty.length === 0) return false;
  const chineseCount = nonempty.filter(cue => textLooksChinese(cue.text)).length;
  return chineseCount / nonempty.length < 0.6;
}

export function formatSrtTimestamp(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalMs = Math.round(safe * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function wrapChineseSubtitle(text: string, maxChars = 18): string {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  const chars = [...compact];
  if (chars.length <= maxChars) return compact;
  const punct = /[，。！？；、,:]/u;
  let breakAt = -1;
  const windowStart = Math.max(1, Math.floor(maxChars * 0.5));
  for (let index = Math.min(chars.length, maxChars); index >= windowStart; index -= 1) {
    if (punct.test(chars[index - 1] || "")) {
      breakAt = index;
      break;
    }
  }
  if (breakAt < 0) breakAt = Math.min(maxChars, chars.length);
  const first = chars.slice(0, breakAt).join("").trim();
  const rest = chars.slice(breakAt).join("").trim();
  if (!rest) return first;
  return `${first}\n${rest}`;
}

export function characterCount(text: string): number {
  return [...String(text || "").replace(/\s+/g, "")].length;
}

export function paginateChineseSubtitle(text: string, maxPerLine = 16, maxLines = 2): string[] {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return [];
  const budget = maxPerLine * maxLines;
  const screens: string[] = [];
  let remaining = compact;
  const punct = /[，。！？；、]/u;
  while (remaining) {
    const chars = [...remaining];
    if (chars.length <= budget) {
      screens.push(wrapChineseSubtitle(remaining, maxPerLine));
      break;
    }
    let cut = budget;
    for (let index = Math.min(chars.length, budget); index >= Math.floor(budget * 0.45); index -= 1) {
      if (punct.test(chars[index - 1] || "")) {
        cut = index;
        break;
      }
    }
    screens.push(wrapChineseSubtitle(chars.slice(0, cut).join("").trim(), maxPerLine));
    remaining = chars.slice(cut).join("").trim();
  }
  if (screens.length >= 2) {
    const last = screens[screens.length - 1].replace(/\s+/g, "");
    if ([...last].length <= 8) {
      const combined = `${screens[screens.length - 2].replaceAll("\n", "")}${screens[screens.length - 1].replaceAll("\n", "")}`;
      screens.splice(screens.length - 2, 2, wrapChineseSubtitle(combined, maxPerLine));
    }
  }
  return screens;
}

export interface SubtitleLayout {
  orientation: "landscape" | "portrait";
  width: number;
  height: number;
  fontSize: number;
  marginV: number;
  marginL: number;
  marginR: number;
  outline: number;
  maxPerLine: number;
  maxLines: number;
}

export function subtitleOrientation(width: number, height: number): SubtitleLayout["orientation"] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "landscape";
  return height > width ? "portrait" : "landscape";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function subtitleLayoutForFrame(width: number, height: number): SubtitleLayout {
  const orientation = subtitleOrientation(width, height);
  if (orientation === "landscape") {
    return {
      orientation,
      width,
      height,
      fontSize: 20,
      marginV: 40,
      marginL: 12,
      marginR: 12,
      outline: 2,
      maxPerLine: 16,
      maxLines: 2,
    };
  }
  // 竖版按宽度定字号，再把边距抬到 B 站底部标题栏和右侧互动栏之上。
  const scale = height / ASS_PLAYRES_Y;
  const fontPx = clamp(Math.round(width * 0.052), 42, 68);
  const marginVPx = clamp(Math.round(height * 0.22), 180, 480);
  return {
    orientation,
    width,
    height,
    fontSize: Math.max(8, Math.round(fontPx / scale)),
    marginV: Math.max(28, Math.round(marginVPx / scale)),
    marginL: Math.max(8, Math.round(width * 0.07 / scale)),
    marginR: Math.max(12, Math.round(width * 0.15 / scale)),
    outline: 1,
    maxPerLine: 11,
    maxLines: 2,
  };
}

function rotationDegrees(stream: { tags?: { rotate?: unknown }; side_data_list?: unknown }): number {
  const tag = Number(stream.tags?.rotate);
  const candidates = [tag];
  if (Array.isArray(stream.side_data_list)) {
    for (const item of stream.side_data_list) {
      candidates.push(Number((item as { rotation?: unknown })?.rotation));
    }
  }
  for (const value of candidates) {
    if (!Number.isFinite(value)) continue;
    return ((Math.round(value) % 360) + 360) % 360;
  }
  return 0;
}

export function frameSizeFromProbe(probe: unknown): { width: number; height: number } | null {
  const streams = (probe as { streams?: unknown })?.streams;
  if (!Array.isArray(streams)) return null;
  const stream = streams.find(item => {
    const candidate = item as { width?: unknown; codec_type?: unknown };
    return candidate?.codec_type === "video" || Number(candidate?.width) > 0;
  }) as { width?: unknown; height?: unknown; tags?: { rotate?: unknown }; side_data_list?: unknown } | undefined;
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  if (!stream || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const rotation = rotationDegrees(stream);
  if (rotation === 90 || rotation === 270) return { width: height, height: width };
  return { width, height };
}

export function readVideoFrameSize(
  videoFile: string,
  ffprobeBin = SUBTITLE_FFPROBE,
): { width: number; height: number } | null {
  if (!existsSync(videoFile) || !existsSync(ffprobeBin)) return null;
  const result = spawnSync(ffprobeBin, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_streams",
    "-of", "json",
    videoFile,
  ], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    return frameSizeFromProbe(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

export function expandSubtitleCues(
  cues: readonly SubtitleCue[],
  layout?: Pick<SubtitleLayout, "maxPerLine" | "maxLines">,
): SubtitleCue[] {
  const expanded: SubtitleCue[] = [];
  for (const cue of cues) {
    const pages = paginateChineseSubtitle(cue.text_zh, layout?.maxPerLine, layout?.maxLines);
    if (pages.length <= 1) {
      expanded.push({ ...cue, text_zh: pages[0] || cue.text_zh });
      continue;
    }
    const duration = Math.max(cue.end - cue.start, 0.85 * pages.length);
    const weights = pages.map(page => Math.max(characterCount(page.replaceAll("\n", "")), 1));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let time = cue.start;
    for (let index = 0; index < pages.length; index += 1) {
      const share = duration * (weights[index] / total);
      const end = index === pages.length - 1 ? cue.end : Math.min(cue.end, time + Math.max(share, 0.7));
      expanded.push({ start: time, end, text: cue.text, text_zh: pages[index] });
      time = end;
    }
  }
  return expanded;
}

export function cuesToSrt(
  cues: readonly SubtitleCue[],
  layout?: Pick<SubtitleLayout, "maxPerLine" | "maxLines">,
): string {
  return expandSubtitleCues(cues, layout).map((cue, offset) => {
    const start = cue.start;
    const end = cue.end > cue.start ? cue.end : cue.start + 0.4;
    const text = (cue.text_zh.includes("\n") ? cue.text_zh : wrapChineseSubtitle(cue.text_zh, layout?.maxPerLine)).replace(/-->/g, "→");
    return `${offset + 1}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${text}\n`;
  }).join("\n");
}

export function chunkByCount<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  const count = Math.max(1, Math.floor(size) || SUBTITLE_BATCH_SIZE);
  for (let index = 0; index < items.length; index += count) {
    batches.push(items.slice(index, index + count) as T[]);
  }
  return batches;
}

export function indexCues(cues: readonly TranscriptCue[]): IndexedCue[] {
  return cues.map((cue, offset) => ({
    index: offset + 1,
    start: cue.start,
    end: cue.end,
    text: String(cue.text || "").trim(),
  })).filter(cue => cue.text);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function endsUtterance(text: string): boolean {
  return /[.!?…]"?$/.test(text.trim());
}

export function mergeFragmentCues(
  cues: readonly IndexedCue[],
  options: { maxWords?: number; maxGapSeconds?: number } = {},
): IndexedCue[] {
  const maxWords = options.maxWords ?? 26;
  const maxGap = options.maxGapSeconds ?? 0.55;
  const merged: IndexedCue[] = [];
  let current: IndexedCue | undefined;
  const flush = () => {
    if (!current) return;
    merged.push(current);
    current = undefined;
  };
  for (const cue of cues) {
    if (!current) {
      current = { ...cue };
      continue;
    }
    const gap = cue.start - current.end;
    const combined = `${current.text} ${cue.text}`.replace(/\s+/g, " ").trim();
    if (gap > maxGap || (wordCount(combined) > maxWords && endsUtterance(current.text))) {
      flush();
      current = { ...cue };
      continue;
    }
    current = {
      index: current.index,
      start: current.start,
      end: cue.end,
      text: combined,
    };
  }
  flush();
  return merged.map((cue, offset) => ({ ...cue, index: offset + 1 }));
}

export function formatEnglishScript(cues: readonly IndexedCue[]): string {
  return cues.map(cue => `${cue.index}. ${cue.text}`).join("\n");
}

export function subtitleGlossaryFromBrief(brief: unknown): string {
  if (!brief || typeof brief !== "object") return "";
  const record = brief as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof record.core_subject === "string" && record.core_subject.trim()) {
    lines.push(`主题：${record.core_subject.trim()}`);
  }
  if (!Array.isArray(record.entities)) return lines.join("\n");
  const names = record.entities.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const original = String((item as { original_name?: unknown }).original_name || "").trim();
    const zhName = String((item as { zh_name?: unknown }).zh_name || "").trim();
    if (!original || !zhName) return [];
    return [`${original} = ${zhName}`];
  });
  if (names.length > 0) lines.push(`专名：${names.join("；")}`);
  return lines.join("\n");
}

export function applyTranslatedCues(batch: readonly IndexedCue[], raw: unknown): TranslatedCue[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("字幕译文不是JSON对象");
  const cues = (raw as { cues?: unknown }).cues;
  if (!Array.isArray(cues)) throw new Error("字幕译文缺少cues");
  const byIndex = new Map<number, string>();
  for (const item of cues) {
    if (!item || typeof item !== "object") continue;
    const index = Number((item as { index?: unknown }).index);
    const text = String((item as { text_zh?: unknown }).text_zh || "").trim();
    if (!Number.isInteger(index) || index < 1 || !text) continue;
    byIndex.set(index, text);
  }
  const missing = batch.filter(item => !byIndex.has(item.index)).map(item => item.index);
  if (missing.length > 0) throw new Error(`字幕译文缺少条目：${missing.slice(0, 8).join("、")}`);
  return batch.map(item => ({ index: item.index, text_zh: byIndex.get(item.index) || item.text }));
}

export function buildChineseSubtitleTranslatePrompt(request: SubtitleTranslateRequest): string {
  const batch = request.batch;
  const start = batch[0]?.index ?? 1;
  const end = batch[batch.length - 1]?.index ?? start;
  const previous = request.previousZh;
  const upcoming = request.upcoming;
  return `你在给整部纪录片写中文口播字幕，不是逐条英译中。

先默读【全文英文口播】，把故事、语气和专名记清楚，再写第 ${start}–${end} 条。这些条目只是时间轴切片，听写经常从句子中间切断。中文必须是连贯口播：相邻条目接上气读，像同一个人在讲；不要每条都重新起头，也不要把半句英文译成半句中文。

硬性要求：
- 只写口播，不要解释、括号、注释或英文
- 专名全文统一，以【用语】和前文中文为准
- 听写明显错词按语义纠正（例如 know where → nowhere）
- 每条 text_zh 是能上口的完整小句，大约 12 到 36 字；不要为了切分去重复上一句已经说过的词
- 本批必须覆盖输入里每一个 index

【用语】
${String(request.context || "").trim() || "无"}

【全文英文口播】
${formatEnglishScript(request.script)}

【已经写好的前文中文】（必须接上，不要改写）
${previous.length > 0 ? previous.map(item => `${item.index}. ${item.text_zh}`).join("\n") : "（片头，没有前文）"}

【本批时间轴，只输出这些 index】
${JSON.stringify(batch.map(item => ({ index: item.index, start: item.start, end: item.end, text: item.text })), null, 2)}

【后面还没写的英文】（只读，不要现在翻译）
${upcoming.length > 0 ? formatEnglishScript(upcoming) : "（已到片尾）"}

只输出 schema 要求的 JSON 对象。`;
}

export function resolveCjkFont(
  candidates: readonly { path: string; name: string }[] = CJK_FONT_CANDIDATES,
): { path: string; name: string; fontsDir: string } {
  const found = candidates.find(item => existsSync(item.path));
  if (!found) throw new Error("没有可用的中文字体，无法烧录字幕");
  return { ...found, fontsDir: dirname(found.path) };
}

export function buildSubtitlesFilter(
  srtFileName: string,
  fontName: string,
  fontsDir: string,
  layout?: SubtitleLayout,
): string {
  const escapedName = String(srtFileName).replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll(":", "\\:");
  const escapedFonts = String(fontsDir).replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll(":", "\\:");
  const portrait = layout?.orientation === "portrait";
  const style = [
    `FontName=${fontName}`,
    `FontSize=${layout?.fontSize ?? 20}`,
    "PrimaryColour=&H00FFFFFF",
    "OutlineColour=&H00000000",
    "BackColour=&H80000000",
    "BorderStyle=1",
    `Outline=${layout?.outline ?? 2}`,
    "Shadow=0",
    ...(portrait ? [`MarginL=${layout.marginL}`, `MarginR=${layout.marginR}`] : []),
    `MarginV=${layout?.marginV ?? 40}`,
    "Alignment=2",
  ].join(",");
  return `subtitles=filename='${escapedName}':fontsdir='${escapedFonts}':force_style='${style}'`;
}

async function waitForProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    isCancelled?: () => boolean;
    onSpawn?: (child: { kill: (signal?: string) => void }) => void;
  },
): Promise<{ code: number; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearInterval(cancelTimer);
      clearTimeout(timeout);
      resolve({ code, stderr: stderr.slice(-4000) });
    };
    options.onSpawn?.(child);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 12_000) stderr = stderr.slice(-8_000);
    });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearInterval(cancelTimer);
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", code => finish(code ?? 1));
    const timeout = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
    }, options.timeoutMs);
    const cancelTimer = setInterval(() => {
      if (!options.isCancelled?.()) return;
      try { child.kill("SIGTERM"); } catch {}
    }, 400);
  });
}

export async function burnChineseSubtitles(options: {
  videoFile: string;
  srtFile: string;
  outputFile: string;
  ffmpegBin?: string;
  ffprobeBin?: string;
  layout?: SubtitleLayout;
  isCancelled?: () => boolean;
  onSpawn?: (child: { kill: (signal?: string) => void }) => void;
}): Promise<void> {
  if (!existsSync(options.videoFile)) throw new Error("没有可烧录字幕的视频");
  if (!existsSync(options.srtFile)) throw new Error("没有中文字幕文件");
  const ffmpegBin = options.ffmpegBin || SUBTITLE_FFMPEG;
  if (!existsSync(ffmpegBin)) throw new Error("找不到可烧录字幕的 ffmpeg");
  const font = resolveCjkFont();
  const frame = options.layout ? null : readVideoFrameSize(options.videoFile, options.ffprobeBin);
  const layout = options.layout ?? (frame ? subtitleLayoutForFrame(frame.width, frame.height) : undefined);
  const filter = buildSubtitlesFilter(basename(options.srtFile), font.name, font.fontsDir, layout);
  const result = await waitForProcess(ffmpegBin, [
    "-y",
    "-i", options.videoFile,
    "-vf", filter,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "copy",
    "-movflags", "+faststart",
    options.outputFile,
  ], {
    cwd: dirname(options.srtFile),
    timeoutMs: 40 * 60 * 1000,
    isCancelled: options.isCancelled,
    onSpawn: options.onSpawn,
  });
  if (options.isCancelled?.()) throw new Error("字幕烧录已取消");
  if (result.code !== 0 || !existsSync(options.outputFile)) {
    throw new Error(`烧录中文字幕失败：${result.stderr.trim().slice(-400) || `exit ${result.code}`}`);
  }
}

export async function materializeChineseSubtitles(options: {
  videoFile: string;
  artifactDir: string;
  cues: readonly TranscriptCue[];
  language?: string;
  context?: string;
  ffmpegBin?: string;
  ffprobeBin?: string;
  translate?: (request: SubtitleTranslateRequest) => Promise<unknown>;
  isCancelled?: () => boolean;
  onProgress?: (message: string) => void;
  onSpawn?: (child: { kill: (signal?: string) => void }) => void;
}): Promise<{ subtitleFile: string; videoFile: string; translated: boolean }> {
  const indexed = mergeFragmentCues(indexCues(options.cues));
  if (indexed.length === 0) throw new Error("没有可做成字幕的转写片段");
  const needsTranslation = transcriptNeedsTranslation(options.language || "", indexed);
  let translated = new Map<number, string>();
  if (needsTranslation) {
    if (!options.translate) throw new Error("外文转写需要翻译成中文字幕，但没有翻译接口");
    options.onProgress?.("正在把听写译成连贯中文口播");
    for (const batch of chunkByCount(indexed, SUBTITLE_BATCH_SIZE)) {
      if (options.isCancelled?.()) throw new Error("字幕翻译已取消");
      const lastIndex = batch[batch.length - 1]?.index ?? 0;
      const previousZh = indexed
        .filter(item => item.index < (batch[0]?.index ?? 1))
        .map(item => ({ index: item.index, text_zh: translated.get(item.index) || "" }))
        .filter(item => item.text_zh)
        .slice(-12);
      const upcoming = indexed.filter(item => item.index > lastIndex).slice(0, 6);
      const parsed = applyTranslatedCues(batch, await options.translate({
        batch,
        script: indexed,
        previousZh,
        upcoming,
        context: options.context,
      }));
      for (const item of parsed) translated.set(item.index, item.text_zh);
    }
  } else {
    translated = new Map(indexed.map(item => [item.index, item.text]));
  }
  const subtitleCues: SubtitleCue[] = indexed.map(item => ({
    start: item.start,
    end: item.end,
    text: item.text,
    text_zh: translated.get(item.index) || item.text,
  }));
  const frame = readVideoFrameSize(options.videoFile, options.ffprobeBin);
  const layout = frame ? subtitleLayoutForFrame(frame.width, frame.height) : undefined;
  const subtitleFile = join(options.artifactDir, SUBTITLE_SRT_NAME);
  const outputFile = join(options.artifactDir, SUBTITLE_VIDEO_NAME);
  writeFileSync(subtitleFile, cuesToSrt(subtitleCues, layout), "utf8");
  const placement = layout?.orientation === "portrait" ? "竖版，避开底部标题栏" : "横版，贴底居中";
  options.onProgress?.(`正在把中文字幕烧进视频（${placement}）`);
  await burnChineseSubtitles({
    videoFile: options.videoFile,
    srtFile: subtitleFile,
    outputFile,
    ffmpegBin: options.ffmpegBin,
    ffprobeBin: options.ffprobeBin,
    layout,
    isCancelled: options.isCancelled,
    onSpawn: options.onSpawn,
  });
  return { subtitleFile, videoFile: outputFile, translated: needsTranslation };
}
