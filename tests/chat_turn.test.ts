import { describe, expect, test } from "bun:test";
import { applyChatTurn, buildChatTurnPrompt } from "../chat_turn";
import type { ContentBrief } from "../metadata_quality";

const brief: ContentBrief = {
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
  source_account: "The Werewolf",
  verified_dialogue: [],
  uncertainties: [],
  forbidden_claims: ["已添加中文字幕"],
};

const result = {
  title_candidates: [
    "蒙古电音派对闯入一匹马",
    "骑马者穿过红光下的舞池",
    "镜头转向人群后马匹登场",
    "电音节拍遇上草原骑手",
    "派对结尾的骑马反差现场",
  ],
  recommended_title_index: 0,
  tags: ["蒙古国", "马匹", "骑乘", "电子音乐", "夜间派对", "人群现场", "灯光舞台", "纪实影像", "反差场面", "短视频"],
  description: "蒙古国一场电音派对进行到后段，镜头从舞台转向台下人群，骑马者随即穿过红色灯光下的现场。马匹出现在舞池旁，构成这段短视频最明确也最有辨识度的反差。",
  tid: 21,
  copy_status: "approved",
  subtitle_file: "",
};

describe("chat turn", () => {
  test("prompt includes brief forbidden claims and current copy", () => {
    const prompt = buildChatTurnPrompt({ brief, result, message: "标题短一点" });
    expect(prompt).toContain("forbidden_claims");
    expect(prompt).toContain("已添加中文字幕");
    expect(prompt).toContain("The Werewolf");
    expect(prompt).toContain("标题短一点");
    expect(prompt).toContain("同一任务的下一轮");
  });

  test("rejects patches that revive forbidden claims", () => {
    const outcome = applyChatTurn({
      brief,
      result,
      patch: { description: `${result.description} 已添加中文字幕。` },
    });
    expect(outcome.accepted).toBe(false);
    expect(outcome.hardIssues.some(issue => issue.includes("禁止的断言"))).toBe(true);
    expect(outcome.result).toEqual(result);
  });

  test("writes an accepted title change without dropping the job", () => {
    const outcome = applyChatTurn({
      brief,
      result,
      patch: { title: "蒙古派对闯入一匹马" },
    });
    expect(outcome.accepted).toBe(true);
    expect(outcome.changed).toContain("标题");
    expect(outcome.result.title_candidates[0]).toBe("蒙古派对闯入一匹马");
  });
});
