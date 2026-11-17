import { describe, expect, test } from "bun:test";
import { applyMetadataChatPatch, chatPatchFromModel } from "../grok_chat";

const base = {
  title_candidates: ["原标题一", "原标题二", "原标题三", "原标题四", "原标题五"],
  recommended_title_index: 0,
  tags: ["现场", "纪录"],
  description: "原来的简介".repeat(10),
  tid: 21,
};

describe("applyMetadataChatPatch", () => {
  test("updates recommended title only", () => {
    const { result, changed } = applyMetadataChatPatch(base, { title: "蒙古派对闯入一匹马" });
    expect(changed).toContain("标题");
    expect(result.title_candidates[0]).toBe("蒙古派对闯入一匹马");
    expect(result.tags).toEqual(base.tags);
  });

  test("replaces tags", () => {
    const { result, changed } = applyMetadataChatPatch(base, { tags: ["现场", "意外"] });
    expect(changed).toEqual(["标签"]);
    expect(result.tags).toEqual(["现场", "意外"]);
  });

  test("rejects empty tags", () => {
    expect(() => applyMetadataChatPatch(base, { tags: ["  "] })).toThrow("标签至少需要1个");
  });
});

describe("chatPatchFromModel", () => {
  test("reads mixed patch", () => {
    const patch = chatPatchFromModel({
      reply: "已缩短标题",
      title: "蒙古派对闯入一匹马",
      tid: 138,
    });
    expect(patch.reply).toBe("已缩短标题");
    expect(patch.title).toBe("蒙古派对闯入一匹马");
    expect(patch.tid).toBe(138);
  });
});
