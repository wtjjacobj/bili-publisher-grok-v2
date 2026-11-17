import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  assessMetadataAgainstBrief,
  buildConservativeDraft,
  reviewIsApproved,
  seriesBaseName,
  type ContentBrief,
  type MetadataDraft,
  type MetadataReview,
} from "../metadata_quality";

const evidence = [
  { id: "source-1", kind: "source", summary_zh: "原帖说明蒙古派对中也有人骑马" },
  { id: "frame-10", kind: "frame", summary_zh: "结尾画面出现骑马者" },
];

function makeMongoliaBrief(overrides: Partial<ContentBrief> = {}): ContentBrief {
  return {
    video_type: "现场短视频",
    core_subject: "蒙古国电音派对",
    core_subject_evidence_ids: ["source-1"],
    core_event: "骑马者进入派对人群",
    core_event_evidence_ids: ["source-1", "frame-10"],
    timeline: [{ time: 22, summary_zh: "骑马者出现在舞池", evidence_ids: ["frame-10"] }],
    turning_point: "镜头转向人群后出现马匹",
    turning_point_evidence_ids: ["frame-10"],
    outcome: "骑马者穿过派对现场",
    outcome_evidence_ids: ["frame-10"],
    hook: "马进入电音派对",
    hook_evidence_ids: ["source-1", "frame-10"],
    evidence,
    entities: [],
    source_account: "Massimo",
    verified_dialogue: [],
    uncertainties: [],
    forbidden_claims: [],
    ...overrides,
  };
}

function makeDraft(overrides: Partial<MetadataDraft> = {}): MetadataDraft {
  const tags = ["蒙古国", "蒙古马", "骑马", "电音派对", "DJ现场", "派对人群", "夜间活动", "现场记录", "反差场面", "短视频"];
  return {
    title_candidates: ["蒙古派对竟有人骑马", "马走进蒙古电音派对", "DJ台下突然出现马匹", "蒙古人的派对少不了马", "电音现场骑马穿过人群"],
    recommended_title_index: 0,
    title_reasons: Array.from({ length: 5 }, (_, index) => ({
      title_index: index,
      evidence_ids: ["source-1", "frame-10"],
      reason: "覆盖核心反差",
    })),
    tags,
    tag_evidence: tags.map(tag => ({ tag, evidence_ids: ["source-1", "frame-10"] })),
    description: "蒙古国一场电音派对进行到后段，镜头从女DJ转向台下人群，骑马者随即穿过红色灯光下的现场。马匹出现在舞池旁，正是这段短视频最有辨识度的反差。",
    tid: 21,
    ...overrides,
  };
}

function loadBriefFixture(name: string): ContentBrief {
  return JSON.parse(readFileSync(
    join(import.meta.dir, "fixtures", "content_briefs", `${name}.json`),
    "utf8",
  ));
}

describe("assessMetadataAgainstBrief", () => {
  test("accepts a draft whose title and tag assertions all cite brief evidence", () => {
    expect(assessMetadataAgainstBrief(makeDraft(), makeMongoliaBrief())).toEqual([]);
  });

  test("rejects titles that summarize the whole plot or dump a list", () => {
    const brief = makeMongoliaBrief({
      timeline: [
        { time: 0, summary_zh: "女助理俯身查资料被当成引诱", evidence_ids: ["source-1"] },
        { time: 12, summary_zh: "作家伸手就要亲她", evidence_ids: ["frame-10"] },
        { time: 40, summary_zh: "妻女同一天死亡仇恨从此生根", evidence_ids: ["frame-10"] },
      ],
      hook: "作家把俯身当成故意勾引",
      core_event: "一次被误解的举止引发报复",
      outcome: "妻女同一天死亡仇恨从此生根",
    });
    const issues = assessMetadataAgainstBrief(
      makeDraft({
        title_candidates: [
          "女助理俯身查资料被当成引诱，妻女同一天死亡仇恨从此生根",
          "坦克蜘蛛挖掘机甲虫潜艇鲨鱼全融合",
          "道具甲、道具乙、道具丙全出场",
          "作家把俯身当成故意勾引",
          "一次被误解的举止引发报复",
        ],
        recommended_title_index: 0,
      }),
      brief,
    );
    expect(issues.some(issue => issue.includes("概述全文") || issue.includes("剧透了结局"))).toBe(true);
    expect(issues.some(issue => issue.includes("清单概述"))).toBe(true);

    const hookOnly = assessMetadataAgainstBrief(
      makeDraft({
        title_candidates: [
          "作家把俯身当成故意勾引",
          "她只是在查资料，他动手了？",
          "一次被误解的举止引发报复",
          "俯身查资料被当成引诱",
          "悬疑片：助理查资料时出事了",
        ],
        recommended_title_index: 1,
      }),
      brief,
    );
    expect(hookOnly.filter(issue => issue.includes("概述全文") || issue.includes("清单概述") || issue.includes("剧透了结局"))).toEqual([]);
  });

  test("rejects an out-of-range recommended title index", () => {
    const issues = assessMetadataAgainstBrief(
      makeDraft({ recommended_title_index: 5 }),
      makeMongoliaBrief(),
    );
    expect(issues).toContain("推荐标题索引必须指向现有候选标题");
  });

  test("rejects draft shapes outside publication schema bounds", () => {
    const issues = assessMetadataAgainstBrief(
      makeDraft({
        title_candidates: ["短", "这是一个超过三十个字符而且不应通过质量检查的标题候选因为它明显超出了既定长度上限", "标题三", "标题四"],
        tags: ["唯一标签"],
        tag_evidence: [{ tag: "唯一标签", evidence_ids: ["source-1"] }],
        description: "过短",
        tid: 0,
      }),
      makeMongoliaBrief(),
    );
    expect(issues).toContain("标题候选必须恰好5个");
    expect(issues).toContain("标题候选长度必须为6到40个字符");
    expect(issues).toContain("标签必须恰好10个");
    expect(issues).toContain("简介长度必须为60到1000个字符");
    expect(issues).toContain("B站分区tid必须是1到9999之间的整数");
  });

  test("rejects duplicate evidence IDs in the fact card", () => {
    const issues = assessMetadataAgainstBrief(
      makeDraft(),
      makeMongoliaBrief({ evidence: [...evidence, { ...evidence[0], summary_zh: "冲突摘要" }] }),
    );
    expect(issues).toContain("事实卡证据ID重复：source-1");
  });

  test("requires non-empty valid evidence links for every core fact", () => {
    const issues = assessMetadataAgainstBrief(
      makeDraft(),
      makeMongoliaBrief({
        core_subject_evidence_ids: ["missing-subject"],
        core_event_evidence_ids: [],
      }),
    );
    expect(issues).toContain("核心主体引用了未知证据：missing-subject");
    expect(issues).toContain("核心事件缺少证据引用");
  });

  test("allows unknown optional facts without invented evidence links", () => {
    const issues = assessMetadataAgainstBrief(
      makeDraft(),
      makeMongoliaBrief({
        turning_point: "",
        turning_point_evidence_ids: [],
        outcome: "",
        outcome_evidence_ids: [],
      }),
    );
    expect(issues).not.toContain("转折缺少证据引用");
    expect(issues).not.toContain("结果缺少证据引用");
  });

  test("requires valid evidence links when an optional fact is asserted", () => {
    const issues = assessMetadataAgainstBrief(
      makeDraft(),
      makeMongoliaBrief({
        turning_point: "镜头转向人群",
        turning_point_evidence_ids: [],
        outcome: "",
        outcome_evidence_ids: ["missing-outcome"],
      }),
    );
    expect(issues).toContain("转折缺少证据引用");
    expect(issues).toContain("结果引用了未知证据：missing-outcome");
  });

  test("rejects dangling timeline, entity, and dialogue evidence links", () => {
    const issues = assessMetadataAgainstBrief(
      makeDraft(),
      makeMongoliaBrief({
        timeline: [{ time: 22, summary_zh: "骑马者出现在舞池", evidence_ids: ["missing-timeline"] }],
        entities: [{
          original_name: "蒙古国",
          zh_name: "蒙古国",
          type: "location",
          confidence: 1,
          evidence_ids: ["missing-entity"],
        }],
        verified_dialogue: [{
          text_original: "Look at the horse",
          text_zh: "看那匹马",
          speaker: "现场人员",
          evidence_ids: ["missing-dialogue"],
        }],
      }),
    );
    expect(issues).toContain("时间线第1项引用了未知证据：missing-timeline");
    expect(issues).toContain("实体第1项引用了未知证据：missing-entity");
    expect(issues).toContain("对白第1项引用了未知证据：missing-dialogue");
  });

  test("accepts structurally valid links even when semantic entailment needs reviewer judgment", () => {
    const issues = assessMetadataAgainstBrief(
      makeDraft(),
      makeMongoliaBrief({ core_subject_evidence_ids: ["frame-10"] }),
    );
    expect(issues.some(issue => issue.includes("核心主体"))).toBe(false);
  });

  test("requires one valid evidence-backed reason for every title", () => {
    const reasons = makeDraft().title_reasons.slice(0, 4);
    reasons[0] = { ...reasons[0], evidence_ids: ["missing-evidence"] };
    const issues = assessMetadataAgainstBrief(
      makeDraft({ title_reasons: reasons }),
      makeMongoliaBrief(),
    );
    expect(issues).toContain("标题依据引用了未知证据：missing-evidence");
    expect(issues).toContain("每个标题候选必须且只能有一条依据");
  });

  test("requires one valid evidence-backed record for every tag", () => {
    const tagEvidence = makeDraft().tag_evidence.slice(1);
    tagEvidence[0] = { ...tagEvidence[0], evidence_ids: ["unknown-frame"] };
    const issues = assessMetadataAgainstBrief(
      makeDraft({ tag_evidence: tagEvidence }),
      makeMongoliaBrief(),
    );
    expect(issues).toContain("标签依据引用了未知证据：unknown-frame");
    expect(issues).toContain("每个标签必须且只能有一条依据");
  });

  test("rejects an English person name when a confirmed Chinese name exists", () => {
    const personBrief = makeMongoliaBrief({
      entities: [{
        original_name: "Rhaenyra Targaryen",
        zh_name: "雷妮拉·坦格利安",
        type: "person",
        confidence: 1,
        evidence_ids: ["source-1"],
      }],
    });
    const issues = assessMetadataAgainstBrief(
      makeDraft({
        title_candidates: ["Rhaenyra Targaryen擂台对决", "雷妮拉走进格斗笼", "龙之家族角色擂台对决", "雷妮拉与阿莉森特开打", "剧中宿敌被放进八角笼"],
      }),
      personBrief,
    );
    expect(issues).toContain("人物名未使用已确认的中文名称：雷妮拉·坦格利安");
  });

  test("rejects normalized meaningful partial person names and invalid type casing", () => {
    const personBrief = makeMongoliaBrief({
      entities: [{
        original_name: "Rhaenyra Targaryen",
        zh_name: "雷妮拉·坦格利安",
        type: "Person",
        confidence: 1,
        evidence_ids: ["source-1"],
      } as any],
    });
    const issues = assessMetadataAgainstBrief(
      makeDraft({
        title_candidates: ["RHAENYRA！擂台对决", ...makeDraft().title_candidates.slice(1)],
      }),
      personBrief,
    );
    expect(issues).toContain("事实卡实体类型无效：Person");
    expect(issues).toContain("人物名未使用已确认的中文名称：雷妮拉·坦格利安");
  });

  test("allows a Latin person name when no confirmed Chinese name exists", () => {
    const personBrief = makeMongoliaBrief({
      entities: [{
        original_name: "Rhaenyra Targaryen",
        zh_name: "",
        type: "person",
        confidence: 1,
        evidence_ids: ["source-1"],
      }],
    });
    const issues = assessMetadataAgainstBrief(
      makeDraft({
        title_candidates: ["Rhaenyra走进格斗笼", ...makeDraft().title_candidates.slice(1)],
      }),
      personBrief,
    );
    expect(issues.some(issue => issue.includes("中文译名") || issue.includes("中文名称"))).toBe(false);
  });

  test("does not treat trivially generic Latin tokens as person aliases", () => {
    const personBrief = makeMongoliaBrief({
      entities: [{
        original_name: "The Doctor",
        zh_name: "博士",
        type: "person",
        confidence: 1,
        evidence_ids: ["source-1"],
      }],
    });
    const issues = assessMetadataAgainstBrief(
      makeDraft({
        title_candidates: ["The派对现场有人骑马", ...makeDraft().title_candidates.slice(1)],
      }),
      personBrief,
    );
    expect(issues).not.toContain("人物名未使用已确认的中文名称：博士");
  });

  test("rejects a full normalized person name even when every token is generic", () => {
    const personBrief = makeMongoliaBrief({
      entities: [{
        original_name: "The Doctor",
        zh_name: "博士",
        type: "person",
        confidence: 1,
        evidence_ids: ["source-1"],
      }],
    });
    const issues = assessMetadataAgainstBrief(
      makeDraft({
        title_candidates: ["THE—DOCTOR来到派对", ...makeDraft().title_candidates.slice(1)],
      }),
      personBrief,
    );
    expect(issues).toContain("人物名未使用已确认的中文名称：博士");
  });

  test("does not block Latin names when zh_name is also Latin", () => {
    const personBrief = makeMongoliaBrief({
      entities: [{
        original_name: "Donny",
        zh_name: "Donny",
        type: "person",
        confidence: 1,
        evidence_ids: ["source-1"],
      }],
    });
    const issues = assessMetadataAgainstBrief(
      makeDraft({
        title_candidates: ["Donny挂窗帘被打断", ...makeDraft().title_candidates.slice(1)],
      }),
      personBrief,
    );
    expect(issues.some(issue => issue.includes("Donny"))).toBe(false);
  });

  test("rejects exact and containment-based near-duplicate tags", () => {
    const tags = ["求婚", "现场求婚", "求婚成功", "情侣", "庆祝", "户外舞台", "观众", "舞蹈", "情感", "求婚"];
    const issues = assessMetadataAgainstBrief(
      makeDraft({
        tags,
        tag_evidence: tags.map(tag => ({ tag, evidence_ids: ["source-1"] })),
      }),
      makeMongoliaBrief(),
    );
    expect(issues.some(issue => issue.includes("标签重复或语义过近"))).toBe(true);
  });

  test("rejects generic-only titles unless they name the subject, event, or hook", () => {
    const genericIssues = assessMetadataAgainstBrief(
      makeDraft({ title_candidates: ["接下来会怎样", ...makeDraft().title_candidates.slice(1)] }),
      makeMongoliaBrief(),
    );
    expect(genericIssues).toContain("标题空泛且未包含已确认的主体、事件或看点：接下来会怎样");

    const groundedIssues = assessMetadataAgainstBrief(
      makeDraft({ title_candidates: ["蒙古国电音派对接下来会怎样", ...makeDraft().title_candidates.slice(1)] }),
      makeMongoliaBrief(),
    );
    expect(groundedIssues.some(issue => issue.startsWith("标题空泛"))).toBe(false);
  });

  test("rejects forbidden claims and subtitle claims when assembly has no subtitle file", () => {
    const draft = makeDraft({
      description: "这段视频已经添加中文字幕，并且明确说明全场观众都在跳舞；除此之外，画面还记录了蒙古国电音派对中骑马者进入人群的过程，相关描述只用于测试禁用断言。",
    });
    const brief = makeMongoliaBrief({ forbidden_claims: ["全场观众都在跳舞"] });
    const issues = assessMetadataAgainstBrief(draft, brief, { subtitle_file: "" });
    expect(issues).toContain("文案包含事实卡明确禁止的断言：全场观众都在跳舞");
    expect(issues).toContain("未生成字幕却声称包含字幕或翻译");
  });

  test("allows burned-in subtitle claims when a subtitle file exists", () => {
    const draft = makeDraft({
      description: "本视频已添加中文字幕。蒙古国电音派对进行到后段，镜头转向台下人群，骑马者穿过红色灯光下的现场，马匹出现在舞池旁。",
    });
    expect(assessMetadataAgainstBrief(draft, makeMongoliaBrief(), { subtitle_file: "/workspace/job/zh.srt" }))
      .not.toContain("未生成字幕却声称包含字幕或翻译");
  });

  test("rejects scoped positive subtitle assertions when no subtitle file exists", () => {
    for (const claim of [
      "本视频已添加中文字幕",
      "成片配有中文字幕",
      "简介提供字幕",
      "画面带有字幕",
      "视频内嵌字幕",
      "成片烧录字幕",
      "本视频自带中文字幕",
      "本视频包含中文字幕",
      "本视频有中文字幕",
      "本视频配字幕",
      "中文字幕已经上线",
      "中文字幕可用",
      "中文字幕可看",
      "中英双字版本",
      "中英字幕版本",
    ]) {
      const issues = assessMetadataAgainstBrief(
        makeDraft({ description: `${claim}。其余文字只描述蒙古国电音派对中骑马者进入人群这一已确认的核心事件，并补足测试所需长度。` }),
        makeMongoliaBrief(),
        { subtitle_file: "" },
      );
      expect(issues, claim).toContain("未生成字幕却声称包含字幕或翻译");
    }
  });

  test("allows dialogue translation and explicit negative subtitle wording", () => {
    for (const wording of [
      "对白中文翻译为‘看那匹马’，这只是事实卡中的对白释义",
      "本视频未添加中文字幕，只根据画面描述事件",
      "成片没有字幕，转写仅用于理解内容",
      "页面未提供字幕文件，也没有烧录字幕",
      "页面不会提供字幕，原视频保持不变",
      "本视频不提供字幕，只描述已确认画面",
      "本视频不添加中文字幕，只描述已确认画面",
      "本视频不烧录字幕，只描述已确认画面",
      "本视频不自带中文字幕，只描述已确认画面",
      "本视频不包含中文字幕，只描述已确认画面",
      "中文字幕未上线，转写只用于理解内容",
      "没有中英字幕，只描述已确认画面",
      "中英字幕不可用，只描述已确认画面",
      "中英双字不能看，只描述已确认画面",
    ]) {
      const issues = assessMetadataAgainstBrief(
        makeDraft({ description: `${wording}。蒙古国电音派对中骑马者进入人群，结尾马匹穿过现场，所有发布文案均来自已有证据。` }),
        makeMongoliaBrief(),
        { subtitle_file: "" },
      );
      expect(issues, wording).not.toContain("未生成字幕却声称包含字幕或翻译");
    }
  });

  test("keeps the two-argument API backward compatible when assembly context is unknown", () => {
    const draft = makeDraft({
      description: "这段视频已添加中文字幕，描述蒙古国电音派对中骑马者进入人群的过程。这里保留足够长度用于兼容旧调用方；旧调用方未提供装配上下文时，质量检查不会猜测字幕文件状态。",
    });
    expect(assessMetadataAgainstBrief(draft, makeMongoliaBrief())).not.toContain("未生成字幕却声称包含字幕或翻译");
  });
});

describe("fixture regressions from historical metadata failures", () => {
  const neutralMongoliaTitles = [
    "蒙古国夜间电音派对",
    "女DJ舞台灯光记录",
    "红光下的派对人群",
    "镜头转向台下观众",
    "电子音乐现场氛围",
  ];

  test("accepts evidence-linked horse aliases without treating unrelated 马 fragments as the hook", () => {
    const brief = loadBriefFixture("mongolia-rave");
    const descriptionWith = (wording: string) =>
      `视频先记录女DJ在红色灯光下操作设备，随后镜头转向台下观众，${wording}。画面呈现蒙古国夜间电子音乐活动的舞台、灯光与人群氛围。`;

    for (const wording of [
      "骑马者进入人群",
      "马儿进入人群",
      "马群进入人群",
      "几匹马进入人群",
      "骏马进入人群",
    ]) {
      const draft = makeDraft({
        title_candidates: neutralMongoliaTitles,
        title_reasons: neutralMongoliaTitles.map((_, index) => ({
          title_index: index,
          evidence_ids: ["source-description", "frame-09"],
          reason: "说明蒙古国电音现场与结尾画面",
        })),
        tag_evidence: makeDraft().tags.map(tag => ({ tag, evidence_ids: ["source-description", "frame-09"] })),
        description: descriptionWith(wording),
      });
      expect(assessMetadataAgainstBrief(draft, brief, { subtitle_file: "" }), wording)
        .not.toContain("文案遗漏事实卡已确认的核心看点：派对结尾马匹进入舞台前的人群");
    }

    for (const wording of ["马上进入人群", "马虎地进入人群", "号码进入人群"]) {
      const draft = makeDraft({
        title_candidates: neutralMongoliaTitles,
        title_reasons: neutralMongoliaTitles.map((_, index) => ({
          title_index: index,
          evidence_ids: ["source-description", "frame-09"],
          reason: "说明蒙古国电音现场与结尾画面",
        })),
        tag_evidence: makeDraft().tags.map(tag => ({ tag, evidence_ids: ["source-description", "frame-09"] })),
        description: descriptionWith(wording),
      });
      expect(assessMetadataAgainstBrief(draft, brief, { subtitle_file: "" }), wording)
        .toContain("文案遗漏事实卡已确认的核心看点：派对结尾马匹进入舞台前的人群");
    }
  });

  test("does not import an unrelated horse concept from evidence shared by a different hook", () => {
    const brief = makeMongoliaBrief({
      hook: "派对结尾熄灯",
      hook_evidence_ids: ["frame-10"],
    });
    const draft = makeDraft({
      title_candidates: neutralMongoliaTitles,
      description: "蒙古国夜间电音派对持续进行，镜头记录女DJ和台下观众。派对结尾熄灯，现场活动随之结束，文案只复述这个已确认的灯光变化。",
    });

    expect(assessMetadataAgainstBrief(draft, brief, { subtitle_file: "" }))
      .not.toContain("文案遗漏事实卡已确认的核心看点：派对结尾熄灯");
  });

  test("rejects Mongolia copy that omits the evidence-backed ending hook from every title and the description", () => {
    const brief = loadBriefFixture("mongolia-rave");
    const draft: MetadataDraft = {
      title_candidates: [
        "蒙古国夜间电音派对",
        "女DJ舞台灯光记录",
        "红光下的派对人群",
        "镜头转向台下观众",
        "电子音乐现场氛围",
      ],
      recommended_title_index: 0,
      title_reasons: [
        { title_index: 0, evidence_ids: ["source-description", "frame-01"], reason: "说明派对地点与类型" },
        { title_index: 1, evidence_ids: ["frame-01"], reason: "说明开头DJ舞台" },
        { title_index: 2, evidence_ids: ["frame-07"], reason: "说明台下人群画面" },
        { title_index: 3, evidence_ids: ["frame-07"], reason: "说明镜头移动" },
        { title_index: 4, evidence_ids: ["source-description", "frame-01"], reason: "概述电音现场" },
      ],
      tags: ["蒙古国", "骑马", "电子音乐", "DJ表演", "夜间活动", "舞台灯光", "派对人群", "现场纪实", "户外演出", "短片记录"],
      tag_evidence: [
        { tag: "蒙古国", evidence_ids: ["source-description"] },
        { tag: "骑马", evidence_ids: ["frame-09"] },
        { tag: "电子音乐", evidence_ids: ["source-description", "frame-01"] },
        { tag: "DJ表演", evidence_ids: ["frame-01"] },
        { tag: "夜间活动", evidence_ids: ["frame-01"] },
        { tag: "舞台灯光", evidence_ids: ["frame-01"] },
        { tag: "派对人群", evidence_ids: ["frame-07"] },
        { tag: "现场纪实", evidence_ids: ["frame-07"] },
        { tag: "户外演出", evidence_ids: ["frame-07"] },
        { tag: "短片记录", evidence_ids: ["frame-01"] },
      ],
      description: "视频先记录女DJ在红色灯光下操作设备并随音乐挥手，随后镜头转向台下聚集的观众。画面呈现蒙古国夜间电子音乐活动的舞台、灯光与人群氛围。",
      tid: 21,
    };

    expect(assessMetadataAgainstBrief(draft, brief, { subtitle_file: "" })).toContain(
      "文案遗漏事实卡已确认的核心看点：派对结尾马匹进入舞台前的人群",
    );
  });

  test("rejects The Werewolf formatted as a film while allowing factual source-account attribution", () => {
    const brief = loadBriefFixture("source-account-not-work");
    const badDraft: MetadataDraft = {
      title_candidates: [
        "《The Werewolf》战火片段",
        "骑兵从浓烟中的战场冲出",
        "燃烧建筑前的士兵队伍",
        "火场与骑兵交替的战争画面",
        "古代军队在烟雾中推进",
      ],
      recommended_title_index: 1,
      title_reasons: [
        { title_index: 0, evidence_ids: ["source-title", "frame-02"], reason: "错误地把账号包装成片名" },
        { title_index: 1, evidence_ids: ["frame-04"], reason: "骑兵冲锋画面" },
        { title_index: 2, evidence_ids: ["frame-02", "frame-07"], reason: "燃烧建筑和士兵" },
        { title_index: 3, evidence_ids: ["frame-02", "frame-04"], reason: "火场与骑兵交替" },
        { title_index: 4, evidence_ids: ["frame-01", "frame-07"], reason: "军队推进画面" },
      ],
      tags: ["古代战争", "骑兵冲锋", "燃烧建筑", "战场浓烟", "士兵队伍", "长兵器", "火场镜头", "战争场面", "影视片段", "短片记录"],
      tag_evidence: [
        { tag: "古代战争", evidence_ids: ["frame-01"] },
        { tag: "骑兵冲锋", evidence_ids: ["frame-04"] },
        { tag: "燃烧建筑", evidence_ids: ["frame-02"] },
        { tag: "战场浓烟", evidence_ids: ["frame-02", "frame-04"] },
        { tag: "士兵队伍", evidence_ids: ["frame-01", "frame-07"] },
        { tag: "长兵器", evidence_ids: ["frame-04"] },
        { tag: "火场镜头", evidence_ids: ["frame-02"] },
        { tag: "战争场面", evidence_ids: ["frame-01", "frame-07"] },
        { tag: "影视片段", evidence_ids: ["source-description"] },
        { tag: "短片记录", evidence_ids: ["frame-07"] },
      ],
      description: "视频由来源账号 The Werewolf 发布。画面先后展示山坡上的士兵、燃烧的传统建筑、从烟雾中冲出的骑兵，以及火场前继续推进的队伍；现有证据没有提供具体作品名称。",
      tid: 181,
    };

    const issues = assessMetadataAgainstBrief(badDraft, brief, { subtitle_file: "" });
    expect(issues).toContain("来源账号被当作作品或影视片名：The Werewolf");

    for (const workFraming of [
      '"The Werewolf"电影片段',
      "“The Werewolf”电影片段",
      "「The Werewolf」电影片段",
      "『The Werewolf』电影片段",
      "'The Werewolf'电影片段",
      "‘The Werewolf’电影片段",
      "【The Werewolf】电影片段",
      "The Werewolf电视剧片段",
      "The Werewolf影集片段",
      "The Werewolf的电影",
      "The Werewolf的作品片段",
      "名叫The Werewolf的电影片段",
      "名为 The Werewolf 的影片",
      "名为【The Werewolf】的剧集",
      "片名为The Werewolf的战争电影",
      "剧名：The Werewolf",
      "片名为Ｔｈｅ　Ｗｅｒｅｗｏｌｆ的战争电影",
    ]) {
      const quotedDraft = {
        ...badDraft,
        title_candidates: [workFraming, ...badDraft.title_candidates.slice(1)],
      };
      expect(assessMetadataAgainstBrief(quotedDraft, brief, { subtitle_file: "" }), workFraming)
        .toContain("来源账号被当作作品或影视片名：The Werewolf");
    }

    for (const attribution of [
      "由The Werewolf发布的影片片段",
      "来源账号“The Werewolf”发布",
      "影片由The Werewolf上传",
    ]) {
      const attributionOnlyDraft: MetadataDraft = {
        ...badDraft,
        title_candidates: [attribution, ...badDraft.title_candidates.slice(1)],
      };
      expect(assessMetadataAgainstBrief(attributionOnlyDraft, brief, { subtitle_file: "" }), attribution)
        .not.toContain("来源账号被当作作品或影视片名：The Werewolf");
    }

    const independentlyConfirmedWork = {
      ...brief,
      entities: [{
        original_name: "The Werewolf",
        zh_name: "狼人",
        type: "work" as const,
        confidence: 0.9,
        evidence_ids: ["source-description"],
      }],
    };
    expect(assessMetadataAgainstBrief(badDraft, independentlyConfirmedWork, { subtitle_file: "" }))
      .not.toContain("来源账号被当作作品或影视片名：The Werewolf");

    const accountIdentityOnlyWork = {
      ...brief,
      evidence: [
        ...brief.evidence,
        { id: "source-uploader", kind: "source" as const, summary_zh: "准备数据中的上传账号名称" },
      ],
      entities: [{
        original_name: "The Werewolf",
        zh_name: "狼人",
        type: "work" as const,
        confidence: 0.9,
        evidence_ids: ["source-uploader"],
      }],
    };
    expect(assessMetadataAgainstBrief(badDraft, accountIdentityOnlyWork, { subtitle_file: "" }))
      .toContain("来源账号被当作作品或影视片名：The Werewolf");
  });

  test("reduces an installment title to the franchise viewers actually search", () => {
    expect(seriesBaseName("变形金刚4：绝迹重生")).toBe("变形金刚");
    expect(seriesBaseName("星球大战：克隆人的进攻")).toBe("星球大战");
    expect(seriesBaseName("速度与激情9")).toBe("速度与激情");
    expect(seriesBaseName("火影忍者")).toBe("火影忍者");
    // 数字在开头是片名的一部分，只有结尾的集数才该剥掉。
    expect(seriesBaseName("7号房的礼物")).toBe("7号房的礼物");
  });

  // 线上 job 65c7364b 和 785b745e：事实卡认出了变形金刚4，5个标题却一个都没带上它，
  // 最值钱的搜索词只躺在标签里，标题位置让给了中国观众基本不搜的外国演员名。
  test("requires the identified franchise to appear in at least one title", () => {
    const brief = loadBriefFixture("mongolia-rave");
    const withWork = (confidence: number): ContentBrief => ({
      ...brief,
      entities: [{
        original_name: "Transformers: Age of Extinction",
        zh_name: "变形金刚4：绝迹重生",
        type: "work" as const,
        confidence,
        evidence_ids: ["frame-10"],
      }],
    });
    const missingFranchise = makeDraft();
    const carriesFranchise = makeDraft({
      title_candidates: [
        "变形金刚名场面：竖中指秒被回瞪",
        "马走进蒙古电音派对",
        "DJ台下突然出现马匹",
        "蒙古人的派对少不了马",
        "电音现场骑马穿过人群",
      ],
    });

    expect(assessMetadataAgainstBrief(missingFranchise, withWork(0.88), { subtitle_file: "" }))
      .toContain("已识别作品「变形金刚」，5个标题必须至少有一个带上它");
    expect(assessMetadataAgainstBrief(carriesFranchise, withWork(0.88), { subtitle_file: "" }).join("\n"))
      .not.toContain("5个标题必须至少有一个带上它");
    // 0.78 这类中间档仍然强制：犹豫的是集数不是系列，否则同一条片子会时强制时不强制。
    expect(assessMetadataAgainstBrief(missingFranchise, withWork(0.78), { subtitle_file: "" }))
      .toContain("已识别作品「变形金刚」，5个标题必须至少有一个带上它");
    // 低到连标签都不能用的作品，不该反过来被强制写进标题。
    expect(assessMetadataAgainstBrief(missingFranchise, withWork(0.65), { subtitle_file: "" }).join("\n"))
      .not.toContain("5个标题必须至少有一个带上它");
  });

  // 线上 job d2fb39fe：系列名负责广域流量、完整片名负责精准推荐，两个都要留，
  // 但查重规则按子串把它们判成了凑数。
  test("keeps a franchise tag alongside the specific installment it belongs to", () => {
    const brief = loadBriefFixture("mongolia-rave");
    const tags = ["变形金刚", "变形金刚4：绝迹重生", "蒙古马", "骑马", "电音派对", "DJ现场", "派对人群", "现场记录", "反差场面", "短视频"];
    const draft = makeDraft({
      title_candidates: ["变形金刚名场面：马闯进电音派对", "马走进蒙古电音派对", "DJ台下突然出现马匹", "蒙古人的派对少不了马", "电音现场骑马穿过人群"],
      tags,
      title_reasons: Array.from({ length: 5 }, (_, title_index) => ({
        title_index,
        evidence_ids: ["source-description", "frame-10"],
        reason: "覆盖核心反差",
      })),
      tag_evidence: tags.map(tag => ({ tag, evidence_ids: ["source-description", "frame-10"] })),
    });

    expect(assessMetadataAgainstBrief(draft, brief, { subtitle_file: "" }).join("\n"))
      .not.toContain("标签重复或语义过近");
    // 真正的凑数仍然要拦：不是系列与集数的包含关系。
    const padded = { ...draft, tags: ["变形金刚", "变形金刚这段", ...tags.slice(2)] };
    expect(assessMetadataAgainstBrief(
      { ...padded, tag_evidence: padded.tags.map(tag => ({ tag, evidence_ids: ["frame-10"] })) },
      brief,
      { subtitle_file: "" },
    ).join("\n")).toContain("标签重复或语义过近");
  });

  test("allows the franchise name below the bar that the full installment title needs", () => {
    const brief = loadBriefFixture("mongolia-rave");
    const withWork = (confidence: number): ContentBrief => ({
      ...brief,
      entities: [{
        original_name: "Transformers: Age of Extinction",
        zh_name: "变形金刚4：绝迹重生",
        type: "work" as const,
        confidence,
        evidence_ids: ["frame-10"],
      }],
    });
    const titled = (name: string) => makeDraft({
      title_candidates: [`${name}这段太损了，装狠直接翻车`, "马走进蒙古电音派对", "DJ台下突然出现马匹", "蒙古人的派对少不了马", "电音现场骑马穿过人群"],
    });

    expect(assessMetadataAgainstBrief(titled("变形金刚"), withWork(0.78), { subtitle_file: "" }).join("\n"))
      .not.toContain("的把握");
    expect(assessMetadataAgainstBrief(titled("变形金刚4：绝迹重生"), withWork(0.78), { subtitle_file: "" }))
      .toContain("事实卡对「变形金刚4：绝迹重生」只有0.78的把握，标题和简介只能写系列名「变形金刚」，完整片名留给标签");
    // 低于总下限时，退到系列名也不行。
    expect(assessMetadataAgainstBrief(titled("变形金刚"), withWork(0.6), { subtitle_file: "" }))
      .toContain("事实卡对「变形金刚4：绝迹重生」只有0.60的把握，不能写进文案");
  });

  test("lets a work be asserted at a lower bar than a real person", () => {
    const brief = loadBriefFixture("mongolia-rave");
    const entity = (type: "work" | "person", zh_name: string, confidence: number): ContentBrief => ({
      ...brief,
      entities: [{ original_name: "Age of Extinction", zh_name, type, confidence, evidence_ids: ["frame-10"] }],
    });
    const named = (name: string) => makeDraft({
      title_candidates: [`${name}名场面：马闯进电音派对`, "马走进蒙古电音派对", "DJ台下突然出现马匹", "蒙古人的派对少不了马", "电音现场骑马穿过人群"],
    });

    expect(assessMetadataAgainstBrief(named("变形金刚"), entity("work", "变形金刚", 0.85), { subtitle_file: "" }).join("\n"))
      .not.toContain("只能当标签");
    expect(assessMetadataAgainstBrief(named("马克·沃尔伯格"), entity("person", "马克·沃尔伯格", 0.85), { subtitle_file: "" }))
      .toContain("事实卡对「马克·沃尔伯格」只有0.85的把握，只能当标签，不能写进标题或简介");
  });

  // 线上 job 65c7364b：好莱坞电影、高能名场面 都是纯品类词，但精确词表匹配不到复合词，
  // 把一份复审全5分的文案压成了人工复核。词尾中心词命中即可，上限仍由 MAX_CATEGORY_TAGS 兜住。
  test("treats compound genre words as category tags that carry no evidence", () => {
    const brief = loadBriefFixture("mongolia-rave");
    const tags = ["蒙古国", "蒙古马", "骑马", "电音派对", "DJ现场", "派对人群", "好莱坞电影", "高能名场面", "现场记录", "短视频"];
    const categoryTags = new Set(["好莱坞电影", "高能名场面"]);
    const draft = makeDraft({
      tags,
      title_reasons: Array.from({ length: 5 }, (_, title_index) => ({
        title_index,
        evidence_ids: ["source-description", "frame-10"],
        reason: "覆盖核心反差",
      })),
      tag_evidence: tags.map(tag => ({
        tag,
        evidence_ids: categoryTags.has(tag) ? [] : ["source-description", "frame-10"],
      })),
    });

    expect(assessMetadataAgainstBrief(draft, brief, { subtitle_file: "" }).join("\n"))
      .not.toContain("标签缺少证据引用");
  });

  // 线上 job 9c19295a：分析阶段凭长相认出三名演员，把握分别是 0.93/0.78/0.70，
  // 事实卡同时写明画面没有姓名字幕。高把握的可以照写，没把握的只能进标签或完全不用。
  test("keeps look-alike identities out of copy they are not confident enough to carry", () => {
    const brief = loadBriefFixture("mongolia-rave");
    const withEntity = (confidence: number): ContentBrief => ({
      ...brief,
      entities: [{
        original_name: "Mark Wahlberg",
        zh_name: "马克·沃尔伯格",
        type: "person" as const,
        confidence,
        evidence_ids: ["frame-10"],
      }],
    });
    const namedInDescription = makeDraft({
      description: "黄色敞篷车里马克·沃尔伯格正色盯回来，他瞬间低头躲开视线，旁边女生先鼓嘴尴尬随即大笑，对面也慢慢笑了，装狠失败。",
    });
    const namedInTagsOnly = makeDraft({
      tags: ["马克·沃尔伯格", "蒙古马", "骑马", "电音派对", "DJ现场", "派对人群", "夜间活动", "现场记录", "反差场面", "短视频"],
      tag_evidence: ["马克·沃尔伯格", "蒙古马", "骑马", "电音派对", "DJ现场", "派对人群", "夜间活动", "现场记录", "反差场面", "短视频"]
        .map(tag => ({ tag, evidence_ids: ["source-1", "frame-10"] })),
    });

    expect(assessMetadataAgainstBrief(namedInDescription, withEntity(0.93), { subtitle_file: "" }).join("\n"))
      .not.toContain("马克·沃尔伯格");
    expect(assessMetadataAgainstBrief(namedInDescription, withEntity(0.78), { subtitle_file: "" }))
      .toContain("事实卡对「马克·沃尔伯格」只有0.78的把握，只能当标签，不能写进标题或简介");
    expect(assessMetadataAgainstBrief(namedInTagsOnly, withEntity(0.78), { subtitle_file: "" }).join("\n"))
      .not.toContain("马克·沃尔伯格");
    expect(assessMetadataAgainstBrief(namedInTagsOnly, withEntity(0.55), { subtitle_file: "" }))
      .toContain("事实卡对「马克·沃尔伯格」只有0.55的把握，不能写进文案");
  });

  test("rejects an unsupported Star Wars character tag with an empty evidence link", () => {
    const brief = loadBriefFixture("star-wars-wedding");
    const draft: MetadataDraft = {
      title_candidates: [
        "星球大战风格的花园婚礼",
        "婚礼镜头切到阳台人物",
        "男子在婚礼上举起收录机",
        "白色盔甲宾客齐聚婚礼",
        "科幻婚礼遇上经典收录机",
      ],
      recommended_title_index: 2,
      title_reasons: [
        { title_index: 0, evidence_ids: ["source-description", "frame-03"], reason: "来源与造型共同支持设定" },
        { title_index: 1, evidence_ids: ["frame-03", "frame-05"], reason: "婚礼场景转到阳台" },
        { title_index: 2, evidence_ids: ["frame-08", "frame-10"], reason: "结尾核心动作" },
        { title_index: 3, evidence_ids: ["frame-03"], reason: "白色盔甲宾客" },
        { title_index: 4, evidence_ids: ["frame-03", "frame-08"], reason: "科幻造型和收录机反差" },
      ],
      tags: ["星球大战", "花园婚礼", "白色盔甲", "婚礼宾客", "阳台人物", "黑色收录机", "科幻恶搞", "礼服新人", "达斯摩尔", "短片记录"],
      tag_evidence: [
        { tag: "星球大战", evidence_ids: ["source-description", "frame-03"] },
        { tag: "花园婚礼", evidence_ids: ["frame-01", "frame-03"] },
        { tag: "白色盔甲", evidence_ids: ["frame-03"] },
        { tag: "婚礼宾客", evidence_ids: ["frame-03"] },
        { tag: "阳台人物", evidence_ids: ["frame-08"] },
        { tag: "黑色收录机", evidence_ids: ["frame-08", "frame-10"] },
        { tag: "科幻恶搞", evidence_ids: ["source-description", "frame-03"] },
        { tag: "礼服新人", evidence_ids: ["frame-01"] },
        { tag: "达斯摩尔", evidence_ids: [] },
        { tag: "短片记录", evidence_ids: ["frame-10"] },
      ],
      description: "花园婚礼上，新人与黑袍主持者站在鲜花拱门前，穿白色盔甲的宾客聚在座席后方。镜头随后切到阳台上一名举着黑色收录机的男子，形成明确的科幻恶搞反差。",
      tid: 181,
    };

    expect(assessMetadataAgainstBrief(draft, brief, { subtitle_file: "" }))
      .toContain("标签缺少证据引用：达斯摩尔");

    const partialHookDraft = {
      ...draft,
      title_candidates: [
        "星球大战风格的花园婚礼",
        "婚礼镜头转向建筑阳台",
        "婚礼镜头切到楼上阳台",
        "白色盔甲宾客齐聚婚礼",
        "科幻婚礼中的阳台来客",
      ],
      description: "花园婚礼上，新人与黑袍主持者站在鲜花拱门前，穿白色盔甲的宾客聚在座席后方。镜头随后从婚礼场地切到建筑阳台和楼上人物，但现有文案没有交代核心动作和关键物件。",
    };
    expect(assessMetadataAgainstBrief(partialHookDraft, brief, { subtitle_file: "" }))
      .toContain("文案遗漏事实卡已确认的核心看点：科幻婚礼中有人在阳台举起收录机");
  });

  test("rejects a Chinese-subtitle claim when the assembled subtitle file is empty", () => {
    const brief = loadBriefFixture("no-subtitle");
    const draft: MetadataDraft = {
      title_candidates: [
        "骑兵从浓烟中的战场冲出",
        "燃烧建筑前的古代军队",
        "火场与骑兵交替的战争片段",
        "士兵在烈焰附近继续推进",
        "浓烟里出现持长兵器的骑兵",
      ],
      recommended_title_index: 0,
      title_reasons: [
        { title_index: 0, evidence_ids: ["frame-04"], reason: "骑兵冲出浓烟" },
        { title_index: 1, evidence_ids: ["frame-02", "frame-07"], reason: "燃烧建筑与军队" },
        { title_index: 2, evidence_ids: ["frame-02", "frame-04"], reason: "火场与骑兵交替" },
        { title_index: 3, evidence_ids: ["frame-07"], reason: "士兵继续推进" },
        { title_index: 4, evidence_ids: ["frame-04"], reason: "骑兵兵器与浓烟" },
      ],
      tags: ["古代战场", "骑兵冲锋", "燃烧建筑", "浓烟画面", "士兵队伍", "长兵器", "火场推进", "战争片段", "影视画面", "短片记录"],
      tag_evidence: [
        { tag: "古代战场", evidence_ids: ["frame-01"] },
        { tag: "骑兵冲锋", evidence_ids: ["frame-04"] },
        { tag: "燃烧建筑", evidence_ids: ["frame-02"] },
        { tag: "浓烟画面", evidence_ids: ["frame-02", "frame-04"] },
        { tag: "士兵队伍", evidence_ids: ["frame-01", "frame-07"] },
        { tag: "长兵器", evidence_ids: ["frame-04"] },
        { tag: "火场推进", evidence_ids: ["frame-07"] },
        { tag: "战争片段", evidence_ids: ["frame-01", "frame-04"] },
        { tag: "影视画面", evidence_ids: ["frame-02"] },
        { tag: "短片记录", evidence_ids: ["frame-07"] },
      ],
      description: "本视频已添加中文字幕。画面先展示浓烟中的士兵队伍和燃烧建筑，随后多名骑兵持长兵器横穿战场，最后回到火场前继续推进的军队；其余描述不推断具体作品或人物身份。",
      tid: 181,
    };

    expect(assessMetadataAgainstBrief(draft, brief, { subtitle_file: "" }))
      .toContain("未生成字幕却声称包含字幕或翻译");
  });

  test("rejects proposal tag stuffing that repeats 求婚 as containment variants", () => {
    const brief = loadBriefFixture("star-wars-wedding");
    const draft: MetadataDraft = {
      title_candidates: [
        "星球大战风格的花园婚礼",
        "婚礼镜头切到阳台人物",
        "男子在婚礼上举起收录机",
        "白色盔甲宾客齐聚婚礼",
        "科幻婚礼遇上经典收录机",
      ],
      recommended_title_index: 2,
      title_reasons: [
        { title_index: 0, evidence_ids: ["source-description", "frame-03"], reason: "来源与造型共同支持设定" },
        { title_index: 1, evidence_ids: ["frame-03", "frame-05"], reason: "婚礼场景转到阳台" },
        { title_index: 2, evidence_ids: ["frame-08", "frame-10"], reason: "结尾核心动作" },
        { title_index: 3, evidence_ids: ["frame-03"], reason: "白色盔甲宾客" },
        { title_index: 4, evidence_ids: ["frame-03", "frame-08"], reason: "科幻造型和收录机反差" },
      ],
      tags: ["求婚", "现场求婚", "求婚成功", "星球大战", "婚礼宾客", "黑色收录机", "白色盔甲", "花园场景", "科幻恶搞", "短片记录"],
      tag_evidence: [
        { tag: "求婚", evidence_ids: ["frame-01"] },
        { tag: "现场求婚", evidence_ids: ["frame-01"] },
        { tag: "求婚成功", evidence_ids: ["frame-01"] },
        { tag: "星球大战", evidence_ids: ["source-description", "frame-03"] },
        { tag: "婚礼宾客", evidence_ids: ["frame-03"] },
        { tag: "黑色收录机", evidence_ids: ["frame-08", "frame-10"] },
        { tag: "白色盔甲", evidence_ids: ["frame-03"] },
        { tag: "花园场景", evidence_ids: ["frame-01"] },
        { tag: "科幻恶搞", evidence_ids: ["source-description", "frame-03"] },
        { tag: "短片记录", evidence_ids: ["frame-10"] },
      ],
      description: "花园婚礼上，新人与黑袍主持者站在鲜花拱门前，穿白色盔甲的宾客聚在座席后方。镜头随后切到阳台上一名举着黑色收录机的男子，形成明确的科幻恶搞反差。",
      tid: 181,
    };

    const issues = assessMetadataAgainstBrief(draft, brief, { subtitle_file: "" });
    expect(issues).toContain("标签重复或语义过近：求婚 / 现场求婚");
    expect(issues).toContain("标签重复或语义过近：求婚 / 求婚成功");
  });
});

function makeReview(overrides: Partial<MetadataReview> = {}): MetadataReview {
  return {
    approved: true,
    scores: {
      grounding: 5,
      relevance: 4,
      specificity: 4,
      chinese_naturalness: 4,
      appeal: 4,
    },
    issues: [],
    rewrite_instructions: [],
    ...overrides,
  };
}

describe("reviewIsApproved", () => {
  test("approves only a clean review that meets every quality threshold", () => {
    expect(reviewIsApproved(makeReview())).toBe(true);
    expect(reviewIsApproved(makeReview({ approved: false }))).toBe(false);
    expect(reviewIsApproved(makeReview({ scores: { ...makeReview().scores, grounding: 4 } }))).toBe(true);
    expect(reviewIsApproved(makeReview({ scores: { ...makeReview().scores, grounding: 3 } }))).toBe(false);
    expect(reviewIsApproved(makeReview({ scores: { ...makeReview().scores, appeal: 3 } }))).toBe(false);
    expect(reviewIsApproved(makeReview({ scores: { ...makeReview().scores, relevance: 3 } }))).toBe(false);
    expect(reviewIsApproved(makeReview({ scores: { ...makeReview().scores, specificity: 3 } }))).toBe(false);
    expect(reviewIsApproved(makeReview({ scores: { ...makeReview().scores, chinese_naturalness: 3 } }))).toBe(false);
    expect(reviewIsApproved(makeReview({ issues: ["标签无依据"] }))).toBe(false);
  });
});

describe("buildConservativeDraft", () => {
  test("limits every fallback title to localized core subject and event facts", () => {
    const brief = makeMongoliaBrief({
      core_subject_evidence_ids: ["source-1"],
      core_event_evidence_ids: ["frame-10"],
      hook: "SENTINEL_HOOK",
      hook_evidence_ids: ["source-1"],
      turning_point: "SENTINEL_TURNING_POINT",
      turning_point_evidence_ids: ["frame-10"],
      outcome: "SENTINEL_OUTCOME",
      outcome_evidence_ids: ["frame-10"],
      timeline: [{ time: 22, summary_zh: "SENTINEL_TIMELINE", evidence_ids: ["frame-10"] }],
      entities: [{
        original_name: "SENTINEL_ENTITY",
        zh_name: "哨兵实体",
        type: "other",
        confidence: 1,
        evidence_ids: ["source-1"],
      }],
    });
    const result = buildConservativeDraft(brief, makeDraft());

    expect(result.title_candidates).toHaveLength(5);
    expect(new Set(result.title_candidates).size).toBe(5);
    expect(result.title_candidates.join("\n")).toContain("蒙古国电音派对");
    expect(result.title_candidates.join("\n")).toContain("骑马者进入派对人群");
    expect(result.title_candidates.join("\n")).not.toMatch(/SENTINEL|哨兵实体|事实概述/);
    for (const title of result.title_candidates) {
      expect(title).not.toMatch(/SENTINEL|哨兵实体/);
      expect([...title].length).toBeGreaterThanOrEqual(6);
      expect([...title].length).toBeLessThanOrEqual(40);
    }
    for (const reason of result.title_reasons) {
      expect([...reason.evidence_ids].sort()).toEqual(["frame-10", "source-1"]);
    }
    expect(assessMetadataAgainstBrief(result, brief, { subtitle_file: "" })).toEqual([]);
  });

  test("rebuilds every publication field without preserving rejected draft copy", () => {
    const original = makeDraft({
      title_candidates: ["字幕版", "全场起舞", "虚构作品震撼首发", "Rhaenyra登场", "这是一个超过三十个字符而且包含完全没有证据支持内容的恶意超长标题候选"],
      tags: ["中文字幕", "全场起舞", "虚构作品", "Rhaenyra", "求婚", "现场求婚", "求婚成功", "首发", "震撼", "热门"],
      tag_evidence: ["中文字幕", "全场起舞", "虚构作品", "Rhaenyra", "求婚", "现场求婚", "求婚成功", "首发", "震撼", "热门"]
        .map(tag => ({ tag, evidence_ids: ["source-1"] })),
      description: "本视频已添加中文字幕，并出现全场起舞和虚构作品角色。这是一段故意包含无证据内容的旧简介，保守回退绝不能继续保留。",
    });
    const brief = makeMongoliaBrief({ forbidden_claims: ["全场起舞", "虚构作品"] });
    const originalSnapshot = structuredClone(original);
    const result = buildConservativeDraft(brief, original);
    const recommended = result.title_candidates[result.recommended_title_index];

    expect(recommended).toContain("蒙古国电音派对");
    expect(recommended).toContain("骑马者进入派对人群");
    expect(result.description).toContain("骑马者进入派对人群");
    expect(result.title_candidates).toHaveLength(5);
    expect(result.tags).toHaveLength(10);
    expect(result.title_reasons).toHaveLength(5);
    expect(result.tag_evidence).toHaveLength(10);
    expect(result.title_candidates.every(title => [...title].length >= 6 && [...title].length <= 40)).toBe(true);
    expect(result.tags.every(tag => tag.length >= 1 && tag.length <= 20)).toBe(true);
    expect(result.description.length).toBeGreaterThanOrEqual(60);
    expect(result.description.length).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(result)).not.toMatch(/中文字幕|全场起舞|虚构作品|Rhaenyra|求婚成功/);
    expect(assessMetadataAgainstBrief(result, brief, { subtitle_file: "" })).toEqual([]);
    expect(original).toEqual(originalSnapshot);
  });

  test("bounds fallback output when confirmed fact fields are very short or long", () => {
    const longFact = "骑马者穿过灯光下的派对人群并从镜头右侧离开现场".repeat(8);
    const brief = makeMongoliaBrief({
      core_subject: "马",
      core_event: "跑",
      hook: "入场",
      turning_point: longFact,
      outcome: longFact,
      timeline: [{ time: 22, summary_zh: longFact, evidence_ids: ["frame-10"] }],
    });
    const result = buildConservativeDraft(brief, makeDraft({ description: "短" }));

    expect(result.title_candidates).toHaveLength(5);
    expect(result.title_candidates.every(title => [...title].length >= 6 && [...title].length <= 40)).toBe(true);
    expect(result.tags).toHaveLength(10);
    expect(result.tags.every(tag => tag.length >= 1 && tag.length <= 20)).toBe(true);
    expect(result.description.length).toBeGreaterThanOrEqual(60);
    expect(result.description.length).toBeLessThanOrEqual(1000);
    expect(assessMetadataAgainstBrief(result, brief, { subtitle_file: "" })).toEqual([]);
  });

  test("localizes confirmed people while rebuilding fallback facts", () => {
    const brief = makeMongoliaBrief({
      core_subject: "Rhaenyra Targaryen",
      entities: [{
        original_name: "Rhaenyra Targaryen",
        zh_name: "雷妮拉·坦格利安",
        type: "person",
        confidence: 1,
        evidence_ids: ["source-1"],
      }],
    });
    const result = buildConservativeDraft(brief, makeDraft());

    expect(JSON.stringify(result)).not.toMatch(/Rhaenyra|Targaryen/i);
    expect(JSON.stringify(result)).toContain("雷妮拉·坦格利安");
    expect(assessMetadataAgainstBrief(result, brief, { subtitle_file: "" })).toEqual([]);
  });

  test("sanitizes partial person aliases throughout fallback facts", () => {
    const brief = makeMongoliaBrief({
      core_subject: "Rhaenyra走进格斗笼",
      core_event: "Rhaenyra挥手后进入现场",
      hook: "镜头跟随Rhaenyra",
      timeline: [{ time: 22, summary_zh: "Rhaenyra走向人群", evidence_ids: ["frame-10"] }],
      entities: [{
        original_name: "Rhaenyra Targaryen",
        zh_name: "雷妮拉·坦格利安",
        type: "person",
        confidence: 1,
        evidence_ids: ["source-1"],
      }],
    });
    const result = buildConservativeDraft(brief, makeDraft());

    expect(JSON.stringify(result)).not.toMatch(/Rhaenyra|Targaryen/i);
    expect(JSON.stringify(result)).toContain("雷妮拉·坦格利安");
    expect(assessMetadataAgainstBrief(result, brief, { subtitle_file: "" })).toEqual([]);
  });

  test("uses a neutral Chinese role for fallback aliases without a confirmed Chinese name", () => {
    const brief = makeMongoliaBrief({
      core_subject: "Rhaenyra进入现场",
      core_event: "Rhaenyra向人群挥手",
      hook: "镜头跟随Rhaenyra",
      entities: [{
        original_name: "Rhaenyra Targaryen",
        zh_name: "",
        type: "person",
        confidence: 1,
        evidence_ids: ["source-1"],
      }],
    });
    const result = buildConservativeDraft(brief, makeDraft());

    expect(JSON.stringify(result)).not.toMatch(/Rhaenyra|Targaryen/i);
    expect(JSON.stringify(result)).toContain("视频中的人物");
    expect(assessMetadataAgainstBrief(result, brief, { subtitle_file: "" })).toEqual([]);
  });

  test("localizes a full generic-token person name before filtering partial aliases", () => {
    for (const [zhName, replacement] of [
      ["博士", "博士"],
      ["", "视频中的人物"],
    ] as const) {
      const brief = makeMongoliaBrief({
        core_subject: "THE—DOCTOR进入现场",
        core_event: "The Doctor向人群挥手",
        hook: "镜头跟随THE DOCTOR",
        timeline: [{ time: 22, summary_zh: "The-Doctor走向人群", evidence_ids: ["frame-10"] }],
        entities: [{
          original_name: "The Doctor",
          zh_name: zhName,
          type: "person",
          confidence: 1,
          evidence_ids: ["source-1"],
        }],
      });
      const result = buildConservativeDraft(brief, makeDraft());

      expect(JSON.stringify(result), zhName || "no zh_name").not.toMatch(/\bthe\b|\bdoctor\b/i);
      expect(JSON.stringify(result), zhName || "no zh_name").toContain(replacement);
      expect(assessMetadataAgainstBrief(result, brief, { subtitle_file: "" }), zhName || "no zh_name").toEqual([]);
    }
  });
});

type JsonSchema = Record<string, any>;

function loadSchema(name: string): JsonSchema {
  return JSON.parse(readFileSync(join(import.meta.dir, "..", name), "utf8"));
}

function expectClosedCodexObjects(schema: JsonSchema, path = "$"): void {
  if (schema.type === "object") {
    expect(schema.additionalProperties, `${path} must reject undeclared fields`).toBe(false);
    expect([...schema.required].sort(), `${path} must require every declared field`).toEqual(
      Object.keys(schema.properties).sort(),
    );
  }
  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      expectClosedCodexObjects(child as JsonSchema, `${path}.${key}`);
    }
  }
  if (schema.items) expectClosedCodexObjects(schema.items, `${path}[]`);
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[keyword])) {
      schema[keyword].forEach((child: JsonSchema, index: number) => {
        expectClosedCodexObjects(child, `${path}.${keyword}[${index}]`);
      });
    }
  }
}

describe("Codex output schemas", () => {
  test("content brief schema requires the complete evidence-first fact card", () => {
    const schema = loadSchema("content_brief_schema.json");
    expect(schema.required).toEqual([
      "video_type", "core_subject", "core_subject_evidence_ids",
      "core_event", "core_event_evidence_ids", "timeline",
      "turning_point", "turning_point_evidence_ids",
      "outcome", "outcome_evidence_ids", "hook", "hook_evidence_ids",
      "evidence", "entities", "source_account",
      "verified_dialogue", "uncertainties", "forbidden_claims",
    ]);
    for (const field of [
      "core_subject_evidence_ids", "core_event_evidence_ids", "hook_evidence_ids",
    ]) {
      expect(schema.properties[field].minItems, field).toBe(1);
    }
    for (const field of ["turning_point_evidence_ids", "outcome_evidence_ids"]) {
      expect(schema.properties[field].minItems, field).toBeUndefined();
    }
    expect(schema.properties.evidence.items.required).toEqual(["id", "kind", "summary_zh"]);
    expect(schema.properties.evidence.items.properties.kind.enum).toEqual(["source", "frame", "transcript"]);
    expect(schema.properties.entities.items.required).toEqual([
      "original_name", "zh_name", "type", "confidence", "evidence_ids",
    ]);
    expect(schema.properties.entities.items.properties.evidence_ids.minItems).toBe(1);
    expect(schema.properties.entities.items.properties.type.enum).toEqual([
      "person", "work", "location", "brand", "event", "organization", "other",
    ]);
    expectClosedCodexObjects(schema);
  });

  test("metadata schema requires five title reasons and ten tag evidence records", () => {
    const schema = loadSchema("metadata_schema.json");
    expect(schema.required).toEqual([
      "title_candidates", "recommended_title_index", "title_reasons",
      "tags", "tag_evidence", "description", "tid",
    ]);
    expect(schema.properties.title_reasons.minItems).toBe(5);
    expect(schema.properties.title_reasons.maxItems).toBe(5);
    expect(schema.properties.title_reasons.items.properties.evidence_ids.minItems).toBe(1);
    expect(schema.properties.tag_evidence.minItems).toBe(10);
    expect(schema.properties.tag_evidence.maxItems).toBe(10);
    expect(schema.properties.tag_evidence.items.properties.evidence_ids.minItems).toBe(0);
    expectClosedCodexObjects(schema);
  });

  test("review schema requires five bounded scores and actionable review fields", () => {
    const schema = loadSchema("metadata_review_schema.json");
    expect(schema.required).toEqual(["approved", "scores", "issues", "rewrite_instructions"]);
    expect(Object.keys(schema.properties.scores.properties)).toEqual([
      "grounding", "relevance", "specificity", "chinese_naturalness", "appeal",
    ]);
    for (const score of Object.values(schema.properties.scores.properties) as JsonSchema[]) {
      expect(score.type).toBe("integer");
      expect(score.minimum).toBe(1);
      expect(score.maximum).toBe(5);
    }
    expectClosedCodexObjects(schema);
  });
});
