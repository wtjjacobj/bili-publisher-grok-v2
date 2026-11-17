/**
 * Throwaway A/B harness: re-runs only the writing stage against fact cards and
 * frames that are already on disk, so the new prompt can be compared with the
 * copy that actually shipped without re-downloading or re-analysing anything.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { runGrokProcess, GROK_PRIMARY_MODEL } from "./grok_model";
import { buildMetadataDraftPrompt } from "./metadata_pipeline";
import { assessMetadataAgainstBrief } from "./metadata_quality";

const ROOT = import.meta.dir;
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

const jobs = process.argv.slice(2);
if (jobs.length === 0) throw new Error("usage: bun ab_draft.ts <jobId...>");

for (const jobId of jobs) {
  const dir = join(ROOT, "workspace", jobId);
  const brief = readJson(join(dir, "content_brief.json"));
  const prepared = readJson(join(dir, "prepare_result.json"));
  const shipped = readJson(join(dir, "result.json"));
  let transcript: unknown;
  try {
    transcript = readJson(join(dir, "transcript.json"));
  } catch {
    transcript = undefined;
  }

  const frames = prepared.analysis_frames || [];
  const prompt = buildMetadataDraftPrompt(brief, "", [], {
    frames,
    transcript: transcript as never,
    source: prepared.source || {},
  });

  process.stderr.write(`[${jobId}] 调用 ${GROK_PRIMARY_MODEL}，附 ${frames.length} 帧…\n`);
  const started = Date.now();
  const run = await runGrokProcess({
    prompt,
    model: GROK_PRIMARY_MODEL,
    cwd: ROOT,
    timeoutMs: 6 * 60 * 1000,
    reasoningEffort: "high",
    images: frames.map((frame: { path: string }) => frame.path),
    outputSchema: join(ROOT, "metadata_schema.json"),
    onRetry: info => process.stderr.write(`[${jobId}] 重试第${info.attempt}次：${info.reason}\n`),
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (run.code !== 0) {
    process.stderr.write(`[${jobId}] 失败(${run.code})：${run.stderr.slice(0, 400)}\n`);
    continue;
  }

  const fresh = JSON.parse(run.stdout);
  const issues = assessMetadataAgainstBrief(fresh, brief, { subtitle_file: "" });
  writeFileSync(join(dir, "ab_new_draft.json"), JSON.stringify({ draft: fresh, issues }, null, 2));

  const show = (label: string, copy: Record<string, unknown>) => {
    const titles = copy.title_candidates as string[];
    const index = Number(copy.recommended_title_index ?? 0);
    console.log(`\n  ── ${label} ──`);
    console.log(`  推荐 │ ${titles[index]}`);
    titles.forEach((title, i) => {
      if (i !== index) console.log(`       │ ${title}`);
    });
    console.log(`  标签 │ ${(copy.tags as string[]).join("  ")}`);
    console.log(`  简介 │ ${String(copy.description).replace(/\n+/g, " ").slice(0, 150)}…`);
  };

  console.log(`\n${"═".repeat(78)}\n${jobId}  ·  ${brief.video_type}  ·  ${elapsed}s  ·  ${run.attempts}次请求`);
  show("改前（线上已发）", shipped);
  show("改后（新提示词）", fresh);
  console.log(`  质检 │ ${issues.length === 0 ? "确定性检查全部通过" : issues.join(" / ")}`);
}
