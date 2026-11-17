import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { loadProjectEnv, runGrokProcess } from "../grok_model";
import {
  buildChineseSubtitleTranslatePrompt,
  materializeChineseSubtitles,
  subtitleGlossaryFromBrief,
  SUBTITLE_FFMPEG,
} from "../chinese_subtitles";

loadProjectEnv(join(import.meta.dir, "..", ".env"));

const jobId = process.argv[2];
if (!jobId) throw new Error("usage: bun scripts/burn_job_subtitles.ts <jobId>");

const root = join(import.meta.dir, "..");
const dir = join(root, "workspace", jobId);
const schema = join(root, "subtitle_cues_schema.json");
const transcript = JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8"));
let context = "添加中文字幕";
try {
  const brief = JSON.parse(readFileSync(join(dir, "content_brief.json"), "utf8"));
  context = [
    "添加中文字幕",
    subtitleGlossaryFromBrief(brief),
  ].filter(Boolean).join("\n");
} catch {}

const primary = process.env.BILI_GROK_PRIMARY_MODEL || process.env.BILI_PUBLISHER_PRIMARY_MODEL || "grok-4.6";
const fallback = process.env.BILI_GROK_FALLBACK_MODEL || process.env.BILI_PUBLISHER_FALLBACK_MODEL || "grok-4.5";

function parseJsonReply(path: string): unknown {
  let raw = readFileSync(path, "utf8").trim();
  if (raw.startsWith("```")) raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(raw);
}

const burned = await materializeChineseSubtitles({
  videoFile: join(dir, "video.mp4"),
  artifactDir: dir,
  cues: transcript.segments,
  language: transcript.language,
  context,
  ffmpegBin: SUBTITLE_FFMPEG,
  onProgress: message => console.log(message),
  translate: async (request) => {
    const runTranslate = async (model: string, attempt: number) => {
      const outputFile = join(dir, `_subtitle_translate_${request.batch[0].index}_${attempt}.json`);
      try { unlinkSync(outputFile); } catch {}
      const prompt = buildChineseSubtitleTranslatePrompt({ ...request, context });
      console.log(`translate ${request.batch[0].index}-${request.batch[request.batch.length - 1].index} with ${model}`);
      const output = await runGrokProcess({
        prompt,
        model,
        cwd: dir,
        reasoningEffort: "medium",
        timeoutMs: 6 * 60 * 1000,
        sandboxMode: "read-only",
        networkAccess: false,
        outputSchema: schema,
        outputFile,
      });
      if (output.code !== 0) throw new Error(output.stderr.slice(-300) || `exit ${output.code}`);
      if (!existsSync(outputFile)) throw new Error("模型未生成字幕译文");
      return parseJsonReply(outputFile);
    };
    try {
      return await runTranslate(primary, 1);
    } catch (error) {
      console.log(`primary failed: ${error instanceof Error ? error.message : error}`);
      return await runTranslate(fallback, 2);
    }
  },
});

const resultPath = join(dir, "result.json");
if (existsSync(resultPath)) {
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  result.video_file = burned.videoFile;
  result.subtitle_file = burned.subtitleFile;
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

const publishStatus = join(dir, "publish_status.json");
if (existsSync(publishStatus)) {
  renameSync(publishStatus, join(dir, "publish_status.prev.json"));
}

console.log(JSON.stringify({
  jobId,
  subtitleFile: burned.subtitleFile,
  videoFile: burned.videoFile,
  translated: burned.translated,
}, null, 2));
