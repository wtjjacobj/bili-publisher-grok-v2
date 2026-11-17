/**
 * Throwaway harness: replays the whole metadata pipeline (fact card, lookup,
 * draft, review, rewrite) against media already on disk, writing to a scratch
 * directory so the original job artifacts stay intact. Covers the analysis stage
 * that the draft-only A/B could not reach.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { GROK_PRIMARY_MODEL, GROK_FALLBACK_MODEL, runGrokProcess } from "./grok_model";
import { runMetadataPipeline } from "./metadata_pipeline";

const ROOT = import.meta.dir;
const FFMPEG = "/opt/homebrew/Caskroom/miniforge/base/bin/ffmpeg";
const SCALE = "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:flags=lanczos";
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf-8"));
const totalKb = (paths: string[]) => Math.round(paths.reduce((sum, p) => sum + statSync(p).size, 0) / 1024);

const args = process.argv.slice(2);
const shrink = args.includes("--shrink");
const jobs = args.filter(arg => !arg.startsWith("--"));
if (jobs.length === 0) throw new Error("usage: bun ab_full.ts [--shrink] <jobId...>");

/** Applies the new capture settings to frames captured before the change. */
async function shrinkFrames(frames: { path: string }[], target: string): Promise<{ path: string }[]> {
  mkdirSync(target, { recursive: true });
  const out: { path: string }[] = [];
  for (const [index, frame] of frames.entries()) {
    const destination = join(target, `frame${String(index + 1).padStart(2, "0")}.jpg`);
    const proc = Bun.spawn([FFMPEG, "-y", "-i", frame.path, "-vf", SCALE, "-q:v", "4", destination, "-loglevel", "error"]);
    if (await proc.exited !== 0) throw new Error(`压缩失败：${frame.path}`);
    out.push({ ...frame, path: destination });
  }
  return out;
}

for (const jobId of jobs) {
  const dir = join(ROOT, "workspace", jobId);
  const scratch = join(dir, "ab_full");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });

  const prepared = readJson(join(dir, "prepare_result.json"));
  const oldBrief = readJson(join(dir, "content_brief.json"));
  const oldResult = readJson(join(dir, "result.json"));
  let transcript: unknown = {};
  try {
    transcript = readJson(join(dir, "transcript.json"));
  } catch {}

  if (shrink) {
    const before = totalKb(prepared.analysis_frames.map((f: { path: string }) => f.path));
    prepared.analysis_frames = await shrinkFrames(prepared.analysis_frames, join(scratch, "frames"));
    const after = totalKb(prepared.analysis_frames.map((f: { path: string }) => f.path));
    process.stderr.write(`  分析帧 ${before}KB → ${after}KB（省 ${Math.round(100 - after * 100 / before)}%）\n`);
  }

  let calls = 0;
  const started = Date.now();
  const output = await runMetadataPipeline({
    prepared,
    transcript: transcript as never,
    userDescription: "",
    artifactDir: scratch,
    primaryModel: GROK_PRIMARY_MODEL,
    fallbackModel: GROK_FALLBACK_MODEL,
    resumeFromBrief: false,
    schemas: {
      contentBrief: join(ROOT, "content_brief_schema.json"),
      metadata: join(ROOT, "metadata_schema.json"),
      review: join(ROOT, "metadata_review_schema.json"),
    },
    onStage: event => process.stderr.write(`  [${event.stage}/${event.status}] ${event.message}${event.model ? ` (${event.model})` : ""}\n`),
    runModel: async request => {
      calls += 1;
      const outputFile = join(scratch, `_call_${calls}_${request.stage}_${request.attempt}.json`);
      try { unlinkSync(outputFile); } catch {}
      const run = await runGrokProcess({
        prompt: request.prompt,
        model: request.model,
        cwd: scratch,
        reasoningEffort: request.reasoningEffort,
        timeoutMs: request.stage === "analysis" ? 8 * 60 * 1000 : 6 * 60 * 1000,
        sandboxMode: "read-only",
        networkAccess: false,
        images: request.images,
        outputSchema: request.outputSchema,
        outputFile,
        onRetry: info => process.stderr.write(`    重试第${info.attempt}次：${info.reason}\n`),
      });
      if (run.code !== 0) throw new Error(run.stderr.slice(0, 300) || "模型调用失败");
      if (!existsSync(outputFile)) throw new Error("模型未生成结构化JSON");
      return readJson(outputFile);
    },
  });

  const elapsed = ((Date.now() - started) / 60000).toFixed(1);
  const brief = output.brief;
  console.log(`\n${"═".repeat(78)}\n${jobId}  ·  ${calls}次模型调用  ·  ${elapsed}分钟  ·  ${output.copyStatus}`);
  console.log(`\n  事实卡 video_type`);
  console.log(`    改前 │ ${oldBrief.video_type}`);
  console.log(`    改后 │ ${brief.video_type}`);
  console.log(`  事实卡 core_subject`);
  console.log(`    改前 │ ${oldBrief.core_subject}`);
  console.log(`    改后 │ ${brief.core_subject}`);
  console.log(`\n  推荐标题`);
  console.log(`    改前 │ ${oldResult.title_candidates[oldResult.recommended_title_index ?? 0]}`);
  console.log(`    改后 │ ${output.result.title_candidates[output.result.recommended_title_index]}`);
  console.log(`  标签`);
  console.log(`    改前 │ ${oldResult.tags.join("  ")}`);
  console.log(`    改后 │ ${output.result.tags.join("  ")}`);
  console.log(`  简介首句`);
  console.log(`    改前 │ ${String(oldResult.description).split(/[。\n]/)[0]}。`);
  console.log(`    改后 │ ${String(output.result.description).split(/[。\n]/)[0]}。`);
  console.log(`\n  审稿分数 │ 事实${output.review.scores.grounding} 贴合${output.review.scores.relevance} 具体${output.review.scores.specificity} 中文${output.review.scores.chinese_naturalness} 吸引${output.review.scores.appeal}`);
  const issues = [...(output.result.review_issues || []), ...(output.result.deterministic_issues || [])];
  console.log(`  遗留问题 │ ${issues.length === 0 ? "无" : issues.join(" / ")}`);
}
