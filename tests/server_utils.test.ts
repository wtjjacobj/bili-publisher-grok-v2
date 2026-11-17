import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as serverUtils from "../server_utils";
import {
  assertExistingFileInside,
  assessGeneratedResult,
  buildCodexArgs,
  isMutationRequestAllowed,
  isPathInside,
  isTrustedHost,
  jobCanContinue,
  jobIsListable,
  MAX_AGENT_TIME_MS,
  PREPARE_TIMEOUT_MS,
  normalizeSplitPoints,
  normalizeTid,
  resolveJobDir,
  concisePrepareError,
  extractSourceUrl,
  validateSourceUrl,
  validateJobId,
} from "../server_utils";
import { assembleResult } from "../metadata_pipeline";
import { assessMetadataAgainstBrief, type ContentBrief, type MetadataDraft } from "../metadata_quality";

const WORKSPACE = "/Users/test/Projects/bili-publisher/workspace";

describe("job path containment", () => {
  test("accepts existing UUID and descriptive job IDs", () => {
    expect(validateJobId("a95b621e")).toBe("a95b621e");
    expect(validateJobId("spacex_ipo_0613_0203")).toBe("spacex_ipo_0613_0203");
  });

  test("rejects traversal, separators, dots, and oversized IDs", () => {
    for (const value of ["..", "../..", "a/b", "a\\b", ".hidden", "", "a".repeat(65)]) {
      expect(() => validateJobId(value)).toThrow();
    }
  });

  test("resolved job directories stay inside workspace", () => {
    expect(resolveJobDir(WORKSPACE, "safe-job")).toBe(`${WORKSPACE}/safe-job`);
    expect(() => resolveJobDir(WORKSPACE, "..")).toThrow();
    expect(isPathInside(WORKSPACE, `${WORKSPACE}/safe-job/result.json`)).toBe(true);
    expect(isPathInside(WORKSPACE, "/Users/test/Projects")).toBe(false);
  });

  test("rejects symlinks that escape an allowed directory", () => {
    const root = mkdtempSync(join(tmpdir(), "bili-path-test-"));
    try {
      const allowed = join(root, "allowed");
      const outside = join(root, "secret.txt");
      mkdirSync(allowed);
      writeFileSync(outside, "secret");
      symlinkSync(outside, join(allowed, "cover.jpg"));
      expect(() => assertExistingFileInside(allowed, join(allowed, "cover.jpg"), "封面")).toThrow();

      const outsideDir = join(root, "outside-dir");
      mkdirSync(outsideDir);
      symlinkSync(outsideDir, join(allowed, "linked-job"));
      expect(() => resolveJobDir(allowed, "linked-job")).toThrow();
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe("local request boundary", () => {
  test("only accepts the configured loopback host", () => {
    expect(isTrustedHost("127.0.0.1:3456", 3456)).toBe(true);
    expect(isTrustedHost("localhost:3456", 3456)).toBe(true);
    expect(isTrustedHost("evil.example:3456", 3456)).toBe(false);
    expect(isTrustedHost("127.0.0.1:9999", 3456)).toBe(false);
  });

  test("rejects cross-site mutations", () => {
    const crossSite = new Request("http://127.0.0.1:3456/api/cleanup", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
    });
    const sameOrigin = new Request("http://127.0.0.1:3456/api/cleanup", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:3456" },
    });
    expect(isMutationRequestAllowed(crossSite, 3456)).toBe(false);
    expect(isMutationRequestAllowed(sameOrigin, 3456)).toBe(true);
  });
});

describe("job recovery visibility", () => {
  // 线上 job 785b745e：分析阶段撞上代理证书错误而失败，视频、分析帧和转写都还在，
  // 但列表按“有事实卡”过滤，任务直接从界面消失，本地准备的成果没有任何入口能捡回来。
  test("keeps a job whose analysis failed after preparation both listable and continuable", () => {
    const analysisFailed = { hasResult: false, hasBrief: false, hasPrepared: true };
    expect(jobCanContinue(analysisFailed)).toBe(true);
    expect(jobIsListable(analysisFailed)).toBe(true);
  });

  test("stops offering continue once copy exists and hides jobs with nothing to resume", () => {
    expect(jobCanContinue({ hasResult: true, hasBrief: true, hasPrepared: true })).toBe(false);
    expect(jobIsListable({ hasResult: true, hasBrief: true, hasPrepared: true })).toBe(true);

    const downloadFailed = { hasResult: false, hasBrief: false, hasPrepared: false };
    expect(jobCanContinue(downloadFailed)).toBe(false);
    expect(jobIsListable(downloadFailed)).toBe(false);

    const timedOutDownload = { hasResult: false, hasBrief: false, hasPrepared: false, hasRequest: true };
    expect(jobCanContinue(timedOutDownload)).toBe(true);
    expect(jobIsListable(timedOutDownload)).toBe(true);
  });

  test("gives long videos hours, not a 25-minute prepare wall", () => {
    expect(PREPARE_TIMEOUT_MS).toBe(3 * 60 * 60 * 1000);
    expect(MAX_AGENT_TIME_MS).toBe(8 * 60 * 60 * 1000);
    expect(PREPARE_TIMEOUT_MS).toBeGreaterThan(25 * 60 * 1000);
    expect(MAX_AGENT_TIME_MS).toBeGreaterThan(PREPARE_TIMEOUT_MS);
  });
});

describe("runtime input validation", () => {
  test("builds a direct restricted Codex command without Hermes", () => {
    const args = buildCodexArgs({
      prompt: "处理当前视频",
      model: "gpt-5.6-terra",
      cwd: "/workspace/job",
      reasoningEffort: "low",
      networkAccess: false,
      images: ["/workspace/job/frame1.jpg"],
      outputSchema: "/workspace/job/schema.json",
      outputFile: "/workspace/job/reply.txt",
    });
    expect(args).toContain("gpt-5.6-terra");
    expect(args).toContain("workspace-write");
    expect(args).toContain("sandbox_workspace_write.network_access=false");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("/workspace/job/frame1.jpg");
    expect(args).toContain("/workspace/job/schema.json");
    expect(args.indexOf("exec")).toBeLessThan(args.indexOf("/workspace/job/frame1.jpg"));
    expect(args).toContain("/workspace/job/reply.txt");
    expect(args.join(" ").toLowerCase()).not.toContain("hermes");
  });

  test("requires an explicit valid Bilibili category ID", () => {
    expect(normalizeTid(202)).toBe(202);
    expect(normalizeTid("122")).toBe(122);
    for (const value of [undefined, "", 0, -1, 1.5, "not-a-number", 100_000]) {
      expect(() => normalizeTid(value)).toThrow();
    }
  });

  test("normalizes split points and rejects abusive values", () => {
    expect(normalizeSplitPoints([20, 10, 10], 30)).toEqual([10, 20]);
    for (const points of [[-1], [0], [30], [31], [Number.NaN], Array.from({ length: 21 }, (_, i) => i + 1)]) {
      expect(() => normalizeSplitPoints(points, 30)).toThrow();
    }
  });

  test("moves rescreenshot timestamps between revisions", () => {
    const buildRescreenshotTimestamps = (serverUtils as Record<string, unknown>).buildRescreenshotTimestamps;
    expect(typeof buildRescreenshotTimestamps).toBe("function");
    if (typeof buildRescreenshotTimestamps !== "function") return;

    expect(buildRescreenshotTimestamps(24, 4, 1)).toEqual([1.2, 7.2, 13.2, 19.2]);
    expect(buildRescreenshotTimestamps(24, 4, 2)).toEqual([2.4, 8.4, 14.4, 20.4]);
  });

  test("pulls a public video URL out of pasted text and hides yt-dlp noise", () => {
    expect(extractSourceUrl("看看这个 https://youtu.be/x7nc9Mk7Lzs?si=abc")).toBe("https://youtu.be/x7nc9Mk7Lzs?si=abc");
    const noisy = [
      "WARNING: Your yt-dlp version (2026.03.17) is older than 90 days!",
      "         To suppress this warning, add --no-update to your command/config.",
      "ERROR: unable to download video data: HTTP Error 403: Forbidden",
    ].join("\n");
    const message = concisePrepareError(noisy);
    expect(message).toContain("403");
    expect(message).not.toContain("WARNING");
    expect(message).not.toContain("older than 90 days");
    expect(concisePrepareError("YouTube 拒绝下载（403）。过几分钟再试。")).toContain("过几分钟再试");
    expect(concisePrepareError("", true)).toBe("视频下载或封面处理超时");
  });

  test("only accepts public http(s) source URLs", () => {
    expect(validateSourceUrl("https://www.bilibili.com/video/BV1xx")).toBe("https://www.bilibili.com/video/BV1xx");
    for (const value of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "http://127.0.0.1:3456/api/jobs",
      "http://localhost/private",
      "http://10.0.0.1/video",
      "not a url",
    ]) {
      expect(() => validateSourceUrl(value)).toThrow();
    }
  });

  test("checks generated Bilibili metadata quality before accepting a result", () => {
    const valid = {
      title_candidates: ["蒙古派对闯入一匹马", "骑马者穿过红光舞池", "镜头转向人群后马匹登场", "电音节拍遇上草原骑手", "派对结尾的骑马反差"],
      recommended_title_index: 2,
      tags: ["蒙古国", "马匹", "骑乘", "电子音乐", "夜间派对", "人群现场", "灯光舞台", "纪实影像", "反差场面", "短视频"],
      description: "蒙古国一场电音派对进行到后段，镜头从舞台转向台下人群，骑马者随即穿过红色灯光下的现场。马匹出现在舞池旁，构成这段短视频最明确也最有辨识度的反差。",
      tid: 188,
      video_file: "/workspace/job/output.mp4",
      screenshots: ["a.jpg", "b.jpg", "c.jpg"],
    };
    expect(assessGeneratedResult(valid)).toEqual([]);
    expect(assessGeneratedResult({ ...valid, recommended_title_index: 5 })).toContain("推荐标题索引必须指向现有候选标题");
    expect(assessGeneratedResult({ ...valid, title_candidates: ["重复", "重复"], tags: ["热门"], description: "太短", tid: null }).length).toBeGreaterThan(3);
  });

  test("assembled results cannot pass grounding checks with unsupported subtitle copy", () => {
    const brief: ContentBrief = {
      video_type: "现场短视频",
      core_subject: "蒙古国电音派对", core_subject_evidence_ids: ["frame-10"],
      core_event: "骑马者进入人群", core_event_evidence_ids: ["frame-10"],
      timeline: [{ time: 22, summary_zh: "骑马者穿过舞池", evidence_ids: ["frame-10"] }],
      turning_point: "", turning_point_evidence_ids: [], outcome: "", outcome_evidence_ids: [],
      hook: "马进入电音派对", hook_evidence_ids: ["frame-10"],
      evidence: [{ id: "frame-10", kind: "frame", summary_zh: "结尾出现骑马者" }],
      entities: [], source_account: "Massimo", verified_dialogue: [], uncertainties: [], forbidden_claims: [],
    };
    const tags = ["蒙古国", "马匹", "骑乘", "电子音乐", "夜间派对", "人群现场", "灯光舞台", "纪实影像", "反差场面", "短视频"];
    const draft: MetadataDraft = {
      title_candidates: ["蒙古派对闯入一匹马", "骑马者穿过红光舞池", "镜头转向人群后马匹登场", "电音节拍遇上草原骑手", "派对结尾的骑马反差"],
      recommended_title_index: 2,
      title_reasons: Array.from({ length: 5 }, (_, title_index) => ({ title_index, evidence_ids: ["frame-10"], reason: "结尾画面依据" })),
      tags,
      tag_evidence: tags.map(tag => ({ tag, evidence_ids: ["frame-10"] })),
      description: "本视频已添加中文字幕。蒙古国电音派对进行到后段，镜头转向台下人群，骑马者随即穿过灯光下的舞池，形成清楚且有画面依据的结尾反差。",
      tid: 188,
    };
    const assembled = assembleResult(draft, {
      video_file: "/workspace/job/output.mp4", screenshots: ["a.jpg", "b.jpg", "c.jpg"], has_speech: true,
    }, "approved");

    expect(assembled.subtitle_file).toBe("");
    expect(assessMetadataAgainstBrief(draft, brief, assembled)).toContain("未生成字幕却声称包含字幕或翻译");
  });
});
