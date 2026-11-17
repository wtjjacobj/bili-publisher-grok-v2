import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ContentBrief, MetadataDraft, MetadataReview } from "../metadata_quality";
import {
  assembleResult,
  buildContentBriefPrompt,
  buildEvidenceInventory,
  buildMetadataDraftPrompt,
  buildMetadataReviewPrompt,
  canResumeFromBrief,
  loadTranscript,
  repairContentBriefEvidence,
  resolveRecommendedTitleIndex,
  runMetadataPipeline,
  validateDistinctAgentModels,
  validateMetadataDraft,
  type MetadataModelRequest,
} from "../metadata_pipeline";

const EVIDENCE_IDS = ["source-title", "frame-10"];

function makeBrief(): ContentBrief {
  return {
    video_type: "现场短视频",
    core_subject: "蒙古国电音派对",
    core_subject_evidence_ids: ["source-title"],
    core_event: "骑马者进入派对人群",
    core_event_evidence_ids: ["source-title", "frame-10"],
    timeline: [{ time: 22, summary_zh: "结尾骑马者穿过舞池", evidence_ids: ["frame-10"] }],
    turning_point: "镜头转向人群后出现马匹",
    turning_point_evidence_ids: ["frame-10"],
    outcome: "骑马者穿过派对现场",
    outcome_evidence_ids: ["frame-10"],
    hook: "马进入电音派对",
    hook_evidence_ids: ["source-title", "frame-10"],
    evidence: [
      { id: "source-title", kind: "source", summary_zh: "原帖标题说明蒙古派对" },
      { id: "frame-10", kind: "frame", summary_zh: "结尾画面出现骑马者" },
    ],
    entities: [],
    source_account: "Massimo",
    verified_dialogue: [],
    uncertainties: [],
    forbidden_claims: ["已添加中文字幕"],
  };
}

function makeDraft(overrides: Partial<MetadataDraft> = {}): MetadataDraft {
  const tags = ["蒙古国", "马匹", "骑乘", "电子音乐", "夜间派对", "人群现场", "灯光舞台", "纪实影像", "反差场面", "短视频"];
  return {
    title_candidates: [
      "蒙古电音派对闯入一匹马",
      "骑马者穿过红光下的舞池",
      "镜头转向人群后马匹登场",
      "电音节拍遇上草原骑手",
      "派对结尾的骑马反差现场",
    ],
    recommended_title_index: 2,
    title_reasons: Array.from({ length: 5 }, (_, title_index) => ({
      title_index,
      evidence_ids: [...EVIDENCE_IDS],
      reason: "覆盖已确认的核心事件和结尾反差",
    })),
    tags,
    tag_evidence: tags.map(tag => ({ tag, evidence_ids: [...EVIDENCE_IDS] })),
    description: "蒙古国一场电音派对进行到后段，镜头从舞台转向台下人群，骑马者随即穿过红色灯光下的现场。马匹出现在舞池旁，构成这段短视频最明确也最有辨识度的反差。",
    tid: 21,
    ...overrides,
  };
}

function makeReview(overrides: Partial<MetadataReview> = {}): MetadataReview {
  return {
    approved: true,
    scores: { grounding: 5, relevance: 5, specificity: 4, chinese_naturalness: 5, appeal: 4 },
    issues: [],
    rewrite_instructions: [],
    ...overrides,
  };
}

function makePrepared(root = "/workspace/job") {
  return {
    video_file: `${root}/video.mp4`,
    screenshots: [`${root}/screenshots/one.jpg`, `${root}/screenshots/two.jpg`, `${root}/screenshots/three.jpg`],
    analysis_frames: Array.from({ length: 10 }, (_, index) => ({
      id: `frame-${String(index + 1).padStart(2, "0")}`,
      time: index + 0.5,
      path: `${root}/analysis_frames/frame${String(index + 1).padStart(2, "0")}.jpg`,
    })),
    transcript_file: `${root}/transcript.json`,
    transcript_status: "ready",
    has_speech: true,
    source: { uploader: "Massimo", title: "Party in Mongolia", duration: 24 },
  };
}

function pipelineOptions(artifactDir: string, runModel: (request: MetadataModelRequest) => Promise<unknown>) {
  return {
    prepared: makePrepared(artifactDir),
    transcript: {
      status: "ready",
      has_speech: true,
      language: "mn",
      segments: [{ start: 0, end: 2, text: "морь" }],
      error: "",
    },
    userDescription: "突出结尾出现马匹的反差",
    artifactDir,
    primaryModel: "primary-model",
    fallbackModel: "fallback-model",
    schemas: {
      contentBrief: "/schemas/content_brief_schema.json",
      metadata: "/schemas/metadata_schema.json",
      review: "/schemas/metadata_review_schema.json",
    },
    runModel,
  };
}

function withTempDir(run: (directory: string) => Promise<void> | void): Promise<void> | void {
  const directory = mkdtempSync(join(tmpdir(), "metadata-pipeline-"));
  const result = run(directory);
  if (result instanceof Promise) return result.finally(() => rmSync(directory, { recursive: true }));
  rmSync(directory, { recursive: true });
}

describe("pure prompt and result boundaries", () => {
  test("accepts distinct writer and reviewer model configuration", () => {
    expect(() => validateDistinctAgentModels("primary-model", "fallback-model")).not.toThrow();
  });

  test("rejects identical writer and reviewer model configuration", () => {
    expect(() => validateDistinctAgentModels("same-model", "same-model")).toThrow("主模型和备用模型必须不同");
  });

  test("analysis prompt separates source account, links every fact, and bans publication copy", () => {
    const prompt = buildContentBriefPrompt(makePrepared(), {
      status: "ready", has_speech: true, language: "mn",
      segments: [{ start: 0, end: 2, text: "морь" }], error: "",
    }, "无");
    expect(prompt).toContain("发布账号不是作品名、人物名或原创作者");
    expect(prompt).toContain("每个核心结论都必须引用 evidence_ids");
    expect(prompt).toContain("未知的转折或结果必须为空字符串，且对应 evidence_ids 必须为空数组");
    expect(prompt).toContain("转写是本地听写，不是翻译");
    expect(prompt).toContain("先读原标题、原简介和评论区线索");
    expect(prompt).toContain("自动听写");
    expect(prompt).toContain("禁止撰写标题、简介、标签或任何投稿文案");
    expect(prompt).toContain("不可扩展的证据清单");
    expect(prompt).toContain('"id": "source-title"');
    expect(prompt).toContain('"id": "frame-01"');
    expect(prompt).toContain('"id": "transcript-01"');
  });

  test("draft and review prompts enforce evidence-bounded Chinese copy that is written to be clicked", () => {
    const draftPrompt = buildMetadataDraftPrompt(makeBrief(), "无", ["删除无证据字幕声明"]);
    expect(draftPrompt).toContain("先读原标题/简介/评论线索");
    expect(draftPrompt).toContain("标题（恰好5个");
    expect(draftPrompt).toContain("恰好10个，按三层分配");
    expect(draftPrompt).toContain("中文通行名");
    expect(draftPrompt).toContain("删除无证据字幕声明");
    expect(draftPrompt).toContain("5种不同的切入角度");
    expect(draftPrompt).toContain("前15个字决定观众点不点");
    expect(draftPrompt).toContain("禁止写“本片为AI生成”");
    expect(draftPrompt).toContain("本流程没有字幕文件");

    // 模型曾把事实卡的字段名 hook 当成证据ID引用，白跑一轮重写。清单必须逐字给出可用ID。
    // entities 只有匿名人物描述时，旧规则会逼出「灰帽男生」这种没人会搜的标签。
    expect(draftPrompt).toContain("这一层只收真实专名");
    expect(draftPrompt).toContain("会不会有观众真的在搜索框里打出这个词");
    expect(draftPrompt).toContain("最多1条可以点到结局或片尾");
    expect(draftPrompt).toContain("禁止清单式概述");
    // 观众看影视片段第一个问题是「这是哪部」，IP 不能只躺在标签里。
    expect(draftPrompt).toContain("用系列名、不用完整片名");
    expect(draftPrompt).toContain("真人演员的姓名");
    expect(draftPrompt).toContain("角色名不受此限");

    expect(draftPrompt).toContain("可用证据ID清单");
    expect(draftPrompt).toContain("source-title｜source｜原帖标题说明蒙古派对");
    expect(draftPrompt).toContain("frame-10｜frame｜结尾画面出现骑马者");
    expect(draftPrompt).toContain("是事实卡的字段名，不是证据ID");

    const watchedDraftPrompt = buildMetadataDraftPrompt(makeBrief(), "无", [], {
      frames: makePrepared().analysis_frames,
      transcript: {
        status: "ready",
        has_speech: true,
        language: "tl",
        segments: [{ start: 1.3, end: 3.3, text: "Tuki! Help!" }],
        error: "",
      },
    });
    expect(watchedDraftPrompt).toContain("Tuki! Help!");
    expect(watchedDraftPrompt).toContain("1.3-3.3s");

    const reviewPrompt = buildMetadataReviewPrompt(makeBrief(), makeDraft());
    expect(reviewPrompt).toContain("拦住真正的事实错误，同时拦住没有人想点开的平庸文案");
    expect(reviewPrompt).toContain("不得以下列理由拒绝");
    expect(reviewPrompt).toContain("rewrite_instructions 必须是具体、可执行的修改要求");
    expect(reviewPrompt).toContain('"subtitle_file": ""');
  });

  test("assembles an approved result without claiming subtitles", () => {
    const result = assembleResult(makeDraft(), makePrepared(), "approved");
    expect(result.recommended_title_index).toBe(2);
    expect(result.copy_status).toBe("approved");
    expect(result.has_speech).toBe(true);
    expect(result.subtitle_file).toBe("");
    expect(result.segments).toEqual([]);
    expect(result.activities).toEqual([]);
    expect(result.video_file).toBe("/workspace/job/video.mp4");

    const withSubtitles = assembleResult(makeDraft(), {
      ...makePrepared(),
      subtitle_file: "/workspace/job/zh.srt",
    }, "approved");
    expect(withSubtitles.subtitle_file).toBe("/workspace/job/zh.srt");

    const legacyPreparedResult = assembleResult(makeDraft(), {
      video_file: "/workspace/job/video.mp4",
      screenshots: [],
      has_speech: false,
    }, "needs_review");
    expect(legacyPreparedResult.transcript_status).toBe("no_speech");
    expect(legacyPreparedResult.has_speech).toBe(false);
  });

  test("normalizes old and malformed results to title index zero", () => {
    expect(resolveRecommendedTitleIndex({ title_candidates: ["旧标题"] })).toBe(0);
    expect(resolveRecommendedTitleIndex({ title_candidates: ["甲", "乙"], recommended_title_index: 8 })).toBe(0);
    expect(resolveRecommendedTitleIndex({ title_candidates: ["甲", "乙"], recommended_title_index: 1 })).toBe(1);
  });

  test("loads missing and corrupt transcripts as unavailable evidence", () => withTempDir(directory => {
    const missing = loadTranscript({ transcript_file: join(directory, "missing.json"), has_speech: null });
    expect(missing.status).toBe("unavailable");
    expect(missing.segments).toEqual([]);
    expect(missing.error).toContain("不存在");

    const corruptPath = join(directory, "transcript.json");
    writeFileSync(corruptPath, "not-json");
    const corrupt = loadTranscript({ transcript_file: corruptPath, has_speech: false });
    expect(corrupt.status).toBe("unavailable");
    expect(corrupt.has_speech).toBe(null);
    expect(corrupt.error).toContain("无法读取");
  }));

  test("degrades parseable transcripts with invalid status, speech state, or segments", () => withTempDir(directory => {
    const transcriptPath = join(directory, "transcript.json");
    const invalidTranscripts = [
      { status: "mystery", has_speech: true, language: "zh", segments: [], error: "" },
      { status: "ready", has_speech: false, language: "zh", segments: [{ start: 0, end: 1, text: "对白" }], error: "" },
      { status: "ready", has_speech: true, language: "zh", segments: [{ start: "bad", end: 1, text: "对白" }], error: "" },
      { status: "ready", has_speech: true, language: "zh", segments: [{ start: 2, end: 1, text: "对白" }], error: "" },
      { status: "ready", has_speech: true, language: "zh", segments: [{ start: 0, end: 1, text: 42 }], error: "" },
      { status: "ready", has_speech: true, language: "zh", segments: [{ start: 0, end: 1, text: "对白", no_speech_prob: "low" }], error: "" },
      { status: "no_speech", has_speech: false, language: "zh", segments: [{ start: 0, end: 1, text: "对白" }], error: "" },
    ];
    for (const [index, transcript] of invalidTranscripts.entries()) {
      writeFileSync(transcriptPath, JSON.stringify(transcript));
      const loaded = loadTranscript({ transcript_file: transcriptPath, has_speech: true });
      expect(loaded.status, `case ${index}`).toBe("unavailable");
      expect(loaded.has_speech, `case ${index}`).toBe(null);
      expect(loaded.segments, `case ${index}`).toEqual([]);
      expect(loaded.error.length, `case ${index}`).toBeGreaterThan(0);
      expect(loaded.error.length, `case ${index}`).toBeLessThanOrEqual(300);
    }
  }));

  test("keeps coherent ready transcript segments and finite confidence values", () => withTempDir(directory => {
    const transcriptPath = join(directory, "transcript.json");
    writeFileSync(transcriptPath, JSON.stringify({
      status: "ready", has_speech: true, language: "mn",
      segments: [{ start: 0, end: 1.25, text: " морь ", avg_logprob: -0.2, no_speech_prob: 0.1 }],
      error: "",
    }));
    const loaded = loadTranscript({ transcript_file: transcriptPath, has_speech: true });
    expect(loaded.status).toBe("ready");
    expect(loaded.has_speech).toBe(true);
    expect(loaded.segments).toEqual([{ start: 0, end: 1.25, text: "морь", avg_logprob: -0.2, no_speech_prob: 0.1 }]);
  }));

  test("uses normalized missing and corrupt transcript state in the prompt and final result", async () => {
    for (const kind of ["missing", "corrupt"] as const) {
      await withTempDir(async artifactDir => {
        const transcriptPath = join(artifactDir, "input-transcript.json");
        if (kind === "corrupt") writeFileSync(transcriptPath, "not-json");
        const transcript = loadTranscript({
          transcript_file: kind === "missing" ? join(artifactDir, "missing.json") : transcriptPath,
          has_speech: true,
        });
        const requests: MetadataModelRequest[] = [];
        const responses = [makeBrief(), makeDraft(), makeReview()];
        const options = pipelineOptions(artifactDir, async request => {
          requests.push(request);
          return responses.shift();
        });
        const output = await runMetadataPipeline({ ...options, transcript });
        const speechState = requests[0].prompt.match(/语音状态：(\{[^\n]+\})/)?.[1] || "";

        expect(JSON.parse(speechState), kind).toEqual({ has_speech: null, transcript_status: "unavailable" });
        expect(requests[0].prompt, kind).not.toContain('"has_speech":true');
        expect(requests[0].prompt, kind).not.toContain('"transcript_status":"ready"');
        expect(output.result.has_speech, kind).toBe(null);
        expect(output.result, kind).toHaveProperty("transcript_status", "unavailable");
      });
    }
  });

  test("keeps normalized no-speech state coherent across prompt and result assembly", () => withTempDir(async artifactDir => {
    const requests: MetadataModelRequest[] = [];
    const responses = [makeBrief(), makeDraft(), makeReview()];
    const options = pipelineOptions(artifactDir, async request => {
      requests.push(request);
      return responses.shift();
    });
    const output = await runMetadataPipeline({
      ...options,
      transcript: { status: "no_speech", has_speech: false, language: "", segments: [], error: "" },
    });
    const speechState = requests[0].prompt.match(/语音状态：(\{[^\n]+\})/)?.[1] || "";

    expect(JSON.parse(speechState)).toEqual({ has_speech: false, transcript_status: "no_speech" });
    expect(output.result.has_speech).toBe(false);
    expect(output.result).toHaveProperty("transcript_status", "no_speech");
  }));
});

describe("metadata pipeline", () => {
  test("fails explicitly before model calls when independent review is impossible", () => withTempDir(async artifactDir => {
    let calls = 0;
    const options = pipelineOptions(artifactDir, async () => {
      calls += 1;
      return makeBrief();
    });

    await expect(runMetadataPipeline({ ...options, fallbackModel: options.primaryModel }))
      .rejects.toThrow("主模型和备用模型必须不同");
    expect(calls).toBe(0);
    expect(existsSync(join(artifactDir, "result.json"))).toBe(false);
  }));

  test("accepts a category tag that carries no evidence link", () => {
    // The schema, this validator and assessMetadataAgainstBrief all gate tag
    // evidence, so a category tag rejected by any one of them never ships.
    const draft = makeDraft();
    const tagEvidence = draft.tag_evidence.map((record, index) => (
      index === 0 ? { ...record, evidence_ids: [] } : record
    ));
    expect(() => validateMetadataDraft({ ...draft, tag_evidence: tagEvidence })).not.toThrow();
    expect(() => validateMetadataDraft({
      ...draft,
      title_reasons: draft.title_reasons.map((reason, index) => (
        index === 0 ? { ...reason, evidence_ids: [] } : reason
      )),
    })).toThrow("标题依据1必须至少包含一个证据ID");
  });

  test("approves genre framing scored at grounding 4 without spending a rewrite", () => withTempDir(async artifactDir => {
    // normalizeReviewFeedback appends an issue for every score below threshold and
    // reviewIsApproved rejects any non-empty issue list, so the two must agree or
    // the relaxed grounding bar silently has no effect.
    const requests: MetadataModelRequest[] = [];
    const responses = [
      makeBrief(),
      makeDraft(),
      makeReview({ scores: { grounding: 4, relevance: 5, specificity: 4, chinese_naturalness: 5, appeal: 5 } }),
    ];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async request => {
      requests.push(request);
      return responses.shift();
    }));

    expect(output.copyStatus).toBe("approved");
    expect(requests.map(request => request.stage)).toEqual(["analysis", "draft", "review"]);
    expect(output.result.review_issues).toEqual([]);
  }));

  test("sends copy nobody would click back for a rewrite even when every fact checks out", () => withTempDir(async artifactDir => {
    const requests: MetadataModelRequest[] = [];
    const dullReview = makeReview({
      scores: { grounding: 5, relevance: 5, specificity: 4, chinese_naturalness: 5, appeal: 2 },
      issues: [],
      rewrite_instructions: [],
    });
    const responses = [makeBrief(), makeDraft(), dullReview, makeDraft(), makeReview()];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async request => {
      requests.push(request);
      return responses.shift();
    }));

    expect(requests.map(request => request.stage)).toEqual(["analysis", "draft", "review", "draft", "review"]);
    expect(requests[3].prompt).toContain("吸引力评分低于4分");
    expect(output.copyStatus).toBe("approved");
  }));

  test("approves the first grounded draft and atomically persists all artifacts", () => withTempDir(async artifactDir => {
    const requests: MetadataModelRequest[] = [];
    const responses = [makeBrief(), makeDraft(), makeReview()];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async request => {
      requests.push(request);
      return responses.shift();
    }));

    expect(output.copyStatus).toBe("approved");
    expect(output.result.copy_status).toBe("approved");
    expect(requests.map(request => request.stage)).toEqual(["analysis", "draft", "review"]);
    expect(requests[0].images).toHaveLength(10);
    expect(requests[1].images).toHaveLength(10);
    expect(requests[1].prompt).toContain("先读原标题/简介/评论线索");
    expect(requests[2].model).toBe("fallback-model");
    expect(requests[0].reasoningEffort).toBe("high");
    expect(requests[1].reasoningEffort).toBe("high");
    expect(requests[2].reasoningEffort).toBe("medium");
    for (const file of ["content_brief.json", "metadata_review.json", "result.json"]) {
      expect(existsSync(join(artifactDir, file))).toBe(true);
      expect(JSON.parse(readFileSync(join(artifactDir, file), "utf8"))).toBeTruthy();
      expect(existsSync(join(artifactDir, `.${file}.tmp`))).toBe(false);
    }
  }));

  test("rewrites once after deterministic rejection and approves the corrected copy", () => withTempDir(async artifactDir => {
    const requests: MetadataModelRequest[] = [];
    const unsupported = makeDraft({
      description: "本视频已添加中文字幕。蒙古国一场电音派对进行到后段，镜头转向台下人群，骑马者穿过红色灯光下的现场。马匹出现在舞池旁，构成最明确的反差。",
    });
    const responses = [makeBrief(), unsupported, makeReview(), makeDraft(), makeReview()];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async request => {
      requests.push(request);
      return responses.shift();
    }));

    expect(output.copyStatus).toBe("approved");
    expect(requests.map(request => request.stage)).toEqual(["analysis", "draft", "review", "draft", "review"]);
    expect(requests[3].prompt).toContain("未生成字幕却声称包含字幕或翻译");
    expect(output.result.subtitle_file).toBe("");
  }));

  test("rewrites a bilingual-subtitle claim even when the reviewer approves it", () => withTempDir(async artifactDir => {
    const requests: MetadataModelRequest[] = [];
    const unsupported = makeDraft({
      description: "这是中英双字版本。蒙古国一场电音派对进行到后段，镜头从舞台转向台下人群，骑马者穿过红色灯光下的现场，马匹与舞池形成清楚且有证据的结尾反差。",
    });
    const responses = [makeBrief(), unsupported, makeReview(), makeDraft(), makeReview()];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async request => {
      requests.push(request);
      return responses.shift();
    }));

    expect(output.copyStatus).toBe("approved");
    expect(requests.map(request => request.stage)).toEqual(["analysis", "draft", "review", "draft", "review"]);
    expect(requests[3].prompt).toContain("未生成字幕却声称包含字幕或翻译");
  }));

  test("uses concrete reviewer instructions for the single rewrite", () => withTempDir(async artifactDir => {
    const requests: MetadataModelRequest[] = [];
    const rejected = makeReview({
      approved: false,
      scores: { grounding: 5, relevance: 3, specificity: 3, chinese_naturalness: 5, appeal: 3 },
      issues: ["第二个标题没有写出结尾马匹"],
      rewrite_instructions: ["把第二个标题改为明确写出结尾骑马者穿过舞池"],
    });
    const responses = [makeBrief(), makeDraft(), rejected, makeDraft(), makeReview()];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async request => {
      requests.push(request);
      return responses.shift();
    }));

    expect(output.copyStatus).toBe("approved");
    expect(requests[3].prompt).toContain("把第二个标题改为明确写出结尾骑马者穿过舞池");
    expect(requests.filter(request => request.stage === "draft")).toHaveLength(2);
  }));

  test("needs_review keeps the last Grok draft instead of empty review placeholders", () => withTempDir(async artifactDir => {
    const rejected = makeReview({
      approved: false,
      issues: ["人物名未使用已确认的中文名称：Donny"],
      rewrite_instructions: ["改成中文名"],
    });
    const grokTags = ["窗帘", "剧情", "亲密", "打断", "名场面", "室内", "短片", "影视", "片段", "传播"];
    const grokDraft = makeDraft({
      title_candidates: [
        "Donny挂窗帘被打断",
        "Belle在床边被撞见",
        "Tuki推门看见这一幕",
        "窗帘名场面再次传播",
        "亲密戏被第三者打断",
      ],
      tags: grokTags,
      tag_evidence: grokTags.map(tag => ({ tag, evidence_ids: [...EVIDENCE_IDS] })),
      description: "室内挂窗帘时Donny与Belle互动后发展到亲密戏，第三者推门进来露出震惊表情。这段kurtina名场面再次在网上传播。",
    });
    const responses = [makeBrief(), grokDraft, rejected, grokDraft, rejected];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async () => responses.shift()));

    expect(output.copyStatus).toBe("needs_review");
    expect(output.result.title_candidates[0]).toBe("Donny挂窗帘被打断");
    expect(output.result.tags).toContain("窗帘");
    expect(output.result.description).toContain("kurtina");
    expect(output.result.title_candidates.join("\n")).not.toContain("内容待核验");
    expect(output.result.tags.join("\n")).not.toContain("人工校验");
    expect(output.result.description).not.toContain("转入人工复核流程");
  }));

  test("keeps the safe first draft when the rewrite introduces an unsafe claim", () => withTempDir(async artifactDir => {
    const firstReview = makeReview({ approved: false, issues: ["标题遗漏结尾马匹"], rewrite_instructions: ["每个标题写明马匹"] });
    const secondReview = makeReview({ approved: false, issues: ["标签仍有无证据地点"], rewrite_instructions: ["删除地点标签"] });
    const badRewrite = makeDraft({
      description: "成片配有中文字幕。蒙古国一场电音派对进行到后段，镜头转向台下人群，骑马者穿过现场。此处故意保留无证据字幕声明以验证第二次失败后的安全回退行为。",
    });
    const responses = [makeBrief(), makeDraft(), firstReview, badRewrite, secondReview];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async () => responses.shift()));

    expect(output.copyStatus).toBe("needs_review");
    expect(output.result.copy_status).toBe("needs_review");
    expect(output.result.description).not.toContain("字幕");
    expect(output.result.review_issues).toContain("标题遗漏结尾马匹");
    expect(output.result.deterministic_issues).toContain("改写稿质量低于初稿，已保留初稿");
    expect(output.review.approved).toBe(false);
  }));

  // 线上 job 9f535488：初稿把事实卡字段名 hook 当证据ID（纯记账问题），审稿却给了满分零问题；
  // 改写稿记账干净但写错表情、标题同质、标签不可搜。按问题总数比较才会留下更好的那一稿。
  test("keeps the better-scoring first draft when the rewrite only fixes a bookkeeping slip", () => withTempDir(async artifactDir => {
    const firstDraft = makeDraft({
      title_reasons: Array.from({ length: 5 }, (_, title_index) => ({
        title_index,
        evidence_ids: ["hook"],
        reason: "引用了事实卡字段名而不是证据ID",
      })),
    });
    const firstReview = makeReview({
      approved: true,
      scores: { grounding: 5, relevance: 5, specificity: 5, chinese_naturalness: 5, appeal: 5 },
    });
    const cleanButWorseRewrite = makeDraft({
      description: "蒙古国一场电音派对进行到后段，镜头从舞台转向台下人群，骑马者随即穿过红色灯光下的现场，马匹出现在舞池旁边，构成这段短视频里最明确的反差场面。",
    });
    const secondReview = makeReview({
      approved: false,
      scores: { grounding: 3, relevance: 5, specificity: 4, chinese_naturalness: 5, appeal: 4 },
      issues: ["简介表情描述与事实卡不符", "五个标题是同一卖点的换说法", "人物描述类标签没有搜索意图"],
      rewrite_instructions: ["改正表情", "补差异化标题", "换可搜标签"],
    });
    const responses = [makeBrief(), firstDraft, firstReview, cleanButWorseRewrite, secondReview];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async () => responses.shift()));

    expect(output.result.deterministic_issues).toContain("改写稿质量低于初稿，已保留初稿");
    expect(output.result.description).toBe(firstDraft.description);
  }));

  test("revalidates a forbidden-claim conservative fallback and replaces unsafe copy", () => withTempDir(async artifactDir => {
    const rejected = makeReview({
      approved: false,
      issues: ["自动文案仍需人工复核"],
      rewrite_instructions: ["删除所有禁止断言"],
    });
    const forbiddenClaims = ["蒙古国电音派对", "骑马者进入派对人群", "马进入电音派对"];
    const brief: ContentBrief = { ...makeBrief(), forbidden_claims: forbiddenClaims };
    const responses = [brief, makeDraft(), rejected, makeDraft(), rejected];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async () => responses.shift()));
    const publicationCopy = [
      ...output.result.title_candidates,
      ...output.result.tags,
      output.result.description,
    ].join("\n");

    expect(output.copyStatus).toBe("needs_review");
    expect(output.result.title_candidates[0]).toBe("蒙古电音派对闯入一匹马");
    expect(output.result.description).toContain("骑马者随即穿过红色灯光下的现场");
    expect(publicationCopy).not.toContain("内容待核验");
    expect(output.result.tags).toHaveLength(10);
    expect((output.result.deterministic_issues || []).some(issue => issue.includes("仍保留 Grok") || issue.includes("禁止"))).toBe(true);
    expect(output.review.issues.length).toBeGreaterThan(0);
  }));

  test("replaces an account-as-work conservative fallback with claim-free manual-review copy", () => withTempDir(async artifactDir => {
    const rejected = makeReview({ approved: false, issues: ["仍需复核"], rewrite_instructions: ["移除作品名断言"] });
    const accountWorkBrief: ContentBrief = {
      ...makeBrief(),
      video_type: "影视片段",
      core_subject: "The Werewolf的电影",
      core_subject_evidence_ids: ["source-description"],
      hook: "The Werewolf作品片段",
      hook_evidence_ids: ["source-description"],
      evidence: [
        ...makeBrief().evidence,
        { id: "source-description", kind: "source", summary_zh: "来源正文把账号名写在影视内容旁" },
      ],
      source_account: "The Werewolf",
    };
    const responses = [accountWorkBrief, makeDraft(), rejected, makeDraft(), rejected];
    const options = pipelineOptions(artifactDir, async () => responses.shift());
    const output = await runMetadataPipeline({
      ...options,
      prepared: {
        ...options.prepared,
        source: {
          uploader: "The Werewolf",
          title: "Party in Mongolia",
          description: "The Werewolf 影视内容",
        },
      },
    });
    const publicationCopy = [...output.result.title_candidates, ...output.result.tags, output.result.description].join("\n");

    expect(output.copyStatus).toBe("needs_review");
    expect(output.result.title_candidates[0]).toBe("蒙古电音派对闯入一匹马");
    expect(publicationCopy).not.toContain("内容待核验");
    expect(output.result.description.length).toBeGreaterThan(60);
    expect(output.review.issues.length).toBeGreaterThan(0);
  }));

  test("keeps a schema-valid manual-review fallback for an arbitrary valid brief", () => withTempDir(async artifactDir => {
    const rejected = makeReview({ approved: false, issues: ["需要人工核验"], rewrite_instructions: ["逐项核验"] });
    const arbitraryBrief: ContentBrief = {
      ...makeBrief(),
      video_type: "记录",
      core_subject: "甲",
      core_subject_evidence_ids: ["source-title"],
      core_event: "乙",
      core_event_evidence_ids: ["frame-10"],
      hook: "丙",
      hook_evidence_ids: ["frame-10"],
      turning_point: "",
      turning_point_evidence_ids: [],
      outcome: "",
      outcome_evidence_ids: [],
    };
    const responses = [arbitraryBrief, makeDraft(), rejected, makeDraft(), rejected];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async () => responses.shift()));

    expect(output.copyStatus).toBe("needs_review");
    expect(output.result.title_candidates[0]).toBe("蒙古电音派对闯入一匹马");
    expect(output.result.title_candidates).toHaveLength(5);
    expect(output.result.title_reasons).toHaveLength(5);
    expect(output.result.tags).toHaveLength(10);
    expect(output.result.tag_evidence).toHaveLength(10);
    expect([...output.result.description].length).toBeGreaterThanOrEqual(60);
    expect([...output.result.description].length).toBeLessThanOrEqual(1000);
    expect(output.result.review_issues?.length).toBeGreaterThan(0);
  }));

  test("normalizes empty failed reviews into actionable rewrite and visible fallback issues", () => withTempDir(async artifactDir => {
    const requests: MetadataModelRequest[] = [];
    const emptyLowReview = makeReview({
      approved: false,
      scores: { grounding: 3, relevance: 3, specificity: 3, chinese_naturalness: 3, appeal: 3 },
      issues: [],
      rewrite_instructions: [],
    });
    const emptyRejectedReview = makeReview({ approved: false, issues: [], rewrite_instructions: [] });
    const responses = [makeBrief(), makeDraft(), emptyLowReview, makeDraft(), emptyRejectedReview];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async request => {
      requests.push(request);
      return responses.shift();
    }));

    expect(requests.map(request => request.stage)).toEqual(["analysis", "draft", "review", "draft", "review"]);
    expect(requests[3].prompt).toContain("事实依据评分低于4分");
    expect(requests[3].prompt).toContain("核心贴合度评分低于4分");
    expect(requests[3].prompt).toContain("具体性评分低于4分");
    expect(requests[3].prompt).toContain("中文自然度评分低于4分");
    expect(requests[3].prompt).toContain("吸引力评分低于4分");
    expect(requests[3].prompt).toContain("逐项核对并修正");
    expect(output.copyStatus).toBe("needs_review");
    expect(output.review.issues.length).toBeGreaterThan(0);
    expect(output.review.rewrite_instructions.length).toBeGreaterThan(0);
    expect((output.result.review_issues || []).length + (output.result.deterministic_issues || []).length).toBeGreaterThan(0);
    const persisted = JSON.parse(readFileSync(join(artifactDir, "result.json"), "utf8"));
    expect(persisted.review_issues.length + persisted.deterministic_issues.length).toBeGreaterThan(0);
  }));

  test("uses fallback only when a primary analysis or writing call fails", () => withTempDir(async artifactDir => {
    const requests: MetadataModelRequest[] = [];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async request => {
      requests.push(request);
      if (request.stage === "analysis" && request.model === "primary-model") throw new Error("analysis unavailable");
      if (request.stage === "draft" && request.model === "primary-model") throw new Error("writer unavailable");
      if (request.stage === "analysis") return makeBrief();
      if (request.stage === "draft") return makeDraft();
      return makeReview();
    }));

    expect(output.copyStatus).toBe("approved");
    expect(requests.map(request => `${request.stage}:${request.model}`)).toEqual([
      "analysis:primary-model",
      "analysis:fallback-model",
      "draft:primary-model",
      "draft:fallback-model",
      "review:primary-model",
    ]);
  }));

  test("rejects a schema-invalid primary draft before review and uses the bounded writer fallback", () => withTempDir(async artifactDir => {
    const requests: MetadataModelRequest[] = [];
    const schemaInvalidDraft = { ...makeDraft(), unexpected_publication_field: "must not persist" };
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async request => {
      requests.push(request);
      if (request.stage === "analysis") return makeBrief();
      if (request.stage === "draft" && request.model === "primary-model") return schemaInvalidDraft;
      if (request.stage === "draft") return makeDraft();
      return makeReview();
    }));

    expect(requests.map(request => `${request.stage}:${request.model}`)).toEqual([
      "analysis:primary-model",
      "draft:primary-model",
      "draft:fallback-model",
      "review:primary-model",
    ]);
    expect(output.copyStatus).toBe("approved");
    expect(output.result).not.toHaveProperty("unexpected_publication_field");
  }));

  test("rejects an invalid primary fact card before persistence and retries analysis once", () => withTempDir(async artifactDir => {
    const requests: MetadataModelRequest[] = [];
    const invalidBrief = { ...makeBrief(), timeline: [] };
    const responses = [invalidBrief, makeBrief(), makeDraft(), makeReview()];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async request => {
      requests.push(request);
      return responses.shift();
    }));

    expect(output.copyStatus).toBe("approved");
    expect(requests.map(request => `${request.stage}:${request.model}`)).toEqual([
      "analysis:primary-model",
      "analysis:fallback-model",
      "draft:primary-model",
      "review:fallback-model",
    ]);
    expect(JSON.parse(readFileSync(join(artifactDir, "content_brief.json"), "utf8")).timeline).toHaveLength(1);
  }));

  test("rejects analyzer-invented evidence IDs and kinds before persistence or writing", () => withTempDir(async artifactDir => {
    const requests: MetadataModelRequest[] = [];
    const inventedBrief = {
      ...makeBrief(),
      core_subject_evidence_ids: ["fabricated-99"],
      core_event_evidence_ids: ["fabricated-99"],
      timeline: [{ time: 22, summary_zh: "虚构画面", evidence_ids: ["fabricated-99"] }],
      turning_point_evidence_ids: ["fabricated-99"],
      outcome_evidence_ids: ["fabricated-99"],
      hook_evidence_ids: ["fabricated-99"],
      evidence: [{ id: "fabricated-99", kind: "guess", summary_zh: "模型自己创造的证据" }],
    };
    const responses = [inventedBrief, makeBrief(), makeDraft(), makeReview()];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async request => {
      requests.push(request);
      return responses.shift();
    }));

    expect(output.copyStatus).toBe("approved");
    expect(requests.map(request => `${request.stage}:${request.model}`)).toEqual([
      "analysis:primary-model", "analysis:fallback-model", "draft:primary-model", "review:fallback-model",
    ]);
    expect(JSON.stringify(output.brief)).not.toContain("fabricated-99");
    expect(JSON.stringify(readFileSync(join(artifactDir, "content_brief.json"), "utf8"))).not.toContain("fabricated-99");
  }));

  test("repairs omitted catalog evidence for cited inventory IDs without failing over", () => withTempDir(async artifactDir => {
    const requests: MetadataModelRequest[] = [];
    const leakyBrief = {
      ...makeBrief(),
      entities: [{
        original_name: "Horse",
        zh_name: "马",
        type: "other",
        confidence: 0.9,
        evidence_ids: ["transcript-01", "frame-10"],
      }],
    };
    const responses = [leakyBrief, makeDraft(), makeReview()];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async request => {
      requests.push(request);
      return responses.shift();
    }));

    expect(output.copyStatus).toBe("approved");
    expect(requests.map(request => `${request.stage}:${request.model}`)).toEqual([
      "analysis:primary-model",
      "draft:primary-model",
      "review:fallback-model",
    ]);
    expect(output.brief.evidence.map(item => item.id)).toContain("transcript-01");
    expect(output.brief.entities[0].evidence_ids).toEqual(["transcript-01", "frame-10"]);
    expect(JSON.parse(readFileSync(join(artifactDir, "content_brief.json"), "utf8")).evidence.map((item: { id: string }) => item.id))
      .toContain("transcript-01");
  }));

  test("appends cited inventory items and drops invented IDs from a leaky brief", () => {
    const leaky = {
      ...makeBrief(),
      entities: [{
        original_name: "Matthew",
        zh_name: "马修",
        type: "person",
        confidence: 0.95,
        evidence_ids: ["transcript-01", "fabricated-99", "frame-10"],
      }],
    };
    const inventory = buildEvidenceInventory(makePrepared(), {
      status: "ready",
      has_speech: true,
      language: "en",
      segments: [{ start: 0, end: 2, text: "Matthew" }],
      error: "",
    });
    repairContentBriefEvidence(leaky, inventory);
    expect(leaky.entities[0].evidence_ids).toEqual(["transcript-01", "frame-10"]);
    expect(leaky.evidence.map(item => item.id)).toContain("transcript-01");
    expect(leaky.evidence.map(item => item.id)).not.toContain("fabricated-99");
  });

  test("rejects a source account absent from prepared provenance", () => withTempDir(async artifactDir => {
    const requests: MetadataModelRequest[] = [];
    const responses = [{ ...makeBrief(), source_account: "The Werewolf" }, makeBrief(), makeDraft(), makeReview()];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async request => {
      requests.push(request);
      return responses.shift();
    }));

    expect(output.copyStatus).toBe("approved");
    expect(requests.slice(0, 2).map(request => request.model)).toEqual(["primary-model", "fallback-model"]);
    expect(output.brief.source_account).toBe("Massimo");
  }));

  test("rejects a same-name work backed only by uploader identity before drafting", () => withTempDir(async artifactDir => {
    const requests: MetadataModelRequest[] = [];
    const accountIdentityOnlyBrief: ContentBrief = {
      video_type: "影视片段",
      core_subject: "The Werewolf的电影",
      core_subject_evidence_ids: ["source-uploader"],
      core_event: "The Werewolf的作品中的战斗",
      core_event_evidence_ids: ["source-uploader"],
      timeline: [{ time: 0, summary_zh: "The Werewolf电影开场", evidence_ids: ["source-uploader"] }],
      turning_point: "",
      turning_point_evidence_ids: [],
      outcome: "",
      outcome_evidence_ids: [],
      hook: "The Werewolf的作品片段",
      hook_evidence_ids: ["source-uploader"],
      evidence: [{ id: "source-uploader", kind: "source", summary_zh: "上传账号名为 The Werewolf" }],
      entities: [],
      source_account: "The Werewolf",
      verified_dialogue: [],
      uncertainties: [],
      forbidden_claims: [],
    };
    const options = pipelineOptions(artifactDir, async request => {
      requests.push(request);
      if (request.stage === "analysis") return accountIdentityOnlyBrief;
      throw new Error("identity-only brief reached drafting");
    });

    await expect(runMetadataPipeline({
      ...options,
      prepared: {
        ...options.prepared,
        source: { uploader: "The Werewolf" },
      },
    })).rejects.toThrow("独立内容证据");
    expect(requests.map(request => request.stage)).toEqual(["analysis", "analysis"]);
    expect(existsSync(join(artifactDir, "content_brief.json"))).toBe(false);
    expect(existsSync(join(artifactDir, "result.json"))).toBe(false);
  }));

  test("rejects a same-name work entity backed only by uploader identity", () => withTempDir(async artifactDir => {
    const requests: MetadataModelRequest[] = [];
    const identityOnlyEntityBrief: ContentBrief = {
      ...makeBrief(),
      evidence: [
        ...makeBrief().evidence,
        { id: "source-uploader", kind: "source", summary_zh: "上传账号名为 The Werewolf" },
      ],
      entities: [{
        original_name: "The Werewolf",
        zh_name: "狼人",
        type: "work",
        confidence: 0.99,
        evidence_ids: ["source-uploader"],
      }],
      source_account: "The Werewolf",
    };
    const options = pipelineOptions(artifactDir, async request => {
      requests.push(request);
      if (request.stage === "analysis") return identityOnlyEntityBrief;
      throw new Error("identity-only entity reached drafting");
    });

    await expect(runMetadataPipeline({
      ...options,
      prepared: { ...options.prepared, source: { uploader: "The Werewolf", title: "Party in Mongolia" } },
    })).rejects.toThrow("独立内容证据");
    expect(requests.map(request => request.stage)).toEqual(["analysis", "analysis"]);
  }));

  test("accepts an independently evidenced work sharing the source-account name", async () => {
    for (const [evidenceId, kind] of [
      ["frame-01", "frame"],
      ["transcript-01", "transcript"],
      ["source-description", "source"],
    ] as const) {
      await withTempDir(async artifactDir => {
        const brief: ContentBrief = {
          ...makeBrief(),
          evidence: [
            ...makeBrief().evidence,
            { id: evidenceId, kind, summary_zh: "独立内容证据确认 The Werewolf 是作品名" },
          ],
          entities: [{
            original_name: "The Werewolf",
            zh_name: "狼人",
            type: "work",
            confidence: 0.99,
            evidence_ids: [evidenceId],
          }],
          source_account: "The Werewolf",
        };
        // 作品一旦被确认，标题就必须带上它，所以这里的草稿也得满足该规则。
        const draft = makeDraft({
          title_candidates: [
            "狼人名场面：派对结尾的骑马反差",
            "骑马者穿过红光下的舞池",
            "镜头转向人群后马匹登场",
            "电音节拍遇上草原骑手",
            "派对结尾的骑马反差现场",
          ],
        });
        const responses = [brief, draft, makeReview()];
        const options = pipelineOptions(artifactDir, async () => responses.shift());
        const output = await runMetadataPipeline({
          ...options,
          prepared: {
            ...options.prepared,
            source: {
              uploader: "The Werewolf",
              title: "Party in Mongolia",
              description: "The Werewolf 是片中作品名",
            },
          },
        });

        expect(output.copyStatus, evidenceId).toBe("approved");
        expect(output.brief.entities[0].evidence_ids, evidenceId).toEqual([evidenceId]);
      });
    }
  });

  test("keeps every reviewer independent from the writer it evaluates", () => withTempDir(async artifactDir => {
    const requests: MetadataModelRequest[] = [];
    const rejected = makeReview({ approved: false, issues: ["需要重写"], rewrite_instructions: ["改写第二个标题"] });
    let reviewCount = 0;
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async request => {
      requests.push(request);
      if (request.stage === "analysis") return makeBrief();
      if (request.stage === "draft" && request.attempt === 2 && request.model === "primary-model") throw new Error("rewrite primary failed");
      if (request.stage === "draft") return makeDraft();
      reviewCount += 1;
      return reviewCount === 1 ? rejected : makeReview();
    }));

    expect(output.copyStatus).toBe("approved");
    expect(requests.map(request => `${request.stage}:${request.model}:${request.attempt}`)).toEqual([
      "analysis:primary-model:1",
      "draft:primary-model:1",
      "review:fallback-model:1",
      "draft:primary-model:2",
      "draft:fallback-model:2",
      "review:primary-model:2",
    ]);
  }));

  test("aborts after the final model response without persisting a cancelled result", () => withTempDir(async artifactDir => {
    let cancelled = false;
    const responses = [makeBrief(), makeDraft(), makeReview()];
    const run = runMetadataPipeline({
      ...pipelineOptions(artifactDir, async request => {
        const response = responses.shift();
        if (request.stage === "review") cancelled = true;
        return response;
      }),
      isCancelled: () => cancelled,
    });

    await expect(run).rejects.toThrow("元数据处理已取消");
    expect(existsSync(join(artifactDir, "content_brief.json"))).toBe(true);
    expect(existsSync(join(artifactDir, "metadata_review.json"))).toBe(false);
    expect(existsSync(join(artifactDir, "result.json"))).toBe(false);
    expect(readdirSync(artifactDir).filter(name => name.endsWith(".tmp"))).toEqual([]);
  }));

  test("resumes from persisted brief and skips analysis", () => withTempDir(async artifactDir => {
    writeFileSync(join(artifactDir, "content_brief.json"), JSON.stringify(makeBrief()));
    const requests: MetadataModelRequest[] = [];
    const output = await runMetadataPipeline(pipelineOptions(artifactDir, async request => {
      requests.push(request);
      if (request.stage === "draft") return makeDraft();
      if (request.stage === "review") return makeReview();
      throw new Error(`unexpected ${request.stage}`);
    }));
    expect(requests.map(request => request.stage)).toEqual(["draft", "review"]);
    expect(output.brief.core_subject).toBe("蒙古国电音派对");
    expect(canResumeFromBrief(artifactDir)).toBe(true);
  }));

  test("applies host lookups after analysis", () => withTempDir(async artifactDir => {
    const withPerson: ContentBrief = {
      ...makeBrief(),
      entities: [{
        original_name: "Elon Musk",
        zh_name: "Elon Musk",
        type: "person",
        confidence: 0.4,
        evidence_ids: ["source-title"],
      }],
    };
    const output = await runMetadataPipeline({
      ...pipelineOptions(artifactDir, async request => {
        if (request.stage === "analysis") return withPerson;
        if (request.stage === "draft") return makeDraft();
        return makeReview();
      }),
      lookupEntities: async () => [{
        query: "Elon Musk",
        original_name: "Elon Musk",
        zh_name: "埃隆·马斯克",
        summary_zh: "企业家",
        source_url: "https://zh.wikipedia.org",
        confidence: 0.85,
      }],
    });
    expect(output.brief.entities[0].zh_name).toBe("埃隆·马斯克");
    expect(JSON.parse(readFileSync(join(artifactDir, "lookup_results.json"), "utf8"))[0].zh_name).toBe("埃隆·马斯克");
  }));
});
