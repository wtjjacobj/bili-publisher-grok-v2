import { describe, expect, test } from "bun:test";
import type { ContentBrief } from "../metadata_quality";
import {
  applyLookupsToBrief,
  latinPersonLookupQueries,
  lookupEntities,
} from "../entity_lookup";

function brief(overrides: Partial<ContentBrief> = {}): ContentBrief {
  return {
    video_type: "现场",
    core_subject: "派对",
    core_subject_evidence_ids: ["source-title"],
    core_event: "有人骑马",
    core_event_evidence_ids: ["frame-10"],
    timeline: [{ time: 1, summary_zh: "结尾出现马", evidence_ids: ["frame-10"] }],
    turning_point: "",
    turning_point_evidence_ids: [],
    outcome: "",
    outcome_evidence_ids: [],
    hook: "马进入派对",
    hook_evidence_ids: ["frame-10"],
    evidence: [
      { id: "source-title", kind: "source", summary_zh: "原帖" },
      { id: "frame-10", kind: "frame", summary_zh: "马" },
    ],
    entities: [
      { original_name: "Elon Musk", zh_name: "Elon Musk", type: "person", confidence: 0.4, evidence_ids: ["source-title"] },
      { original_name: "Anakin Skywalker", zh_name: "阿纳金·天行者", type: "person", confidence: 0.9, evidence_ids: ["source-title"] },
      { original_name: "SpaceX", zh_name: "SpaceX", type: "brand", confidence: 0.8, evidence_ids: ["source-title"] },
    ],
    source_account: "Massimo",
    verified_dialogue: [],
    uncertainties: [],
    forbidden_claims: [],
    ...overrides,
  };
}

describe("entity lookup", () => {
  test("only queues latin person names that are not already localized", () => {
    expect(latinPersonLookupQueries(brief())).toEqual(["Elon Musk"]);
  });

  test("merges wikipedia hits as lookup evidence and chinese names", () => {
    const updated = applyLookupsToBrief(brief(), [{
      query: "Elon Musk",
      original_name: "Elon Musk",
      zh_name: "埃隆·马斯克",
      summary_zh: "企业家",
      source_url: "https://zh.wikipedia.org/wiki/埃隆·马斯克",
      confidence: 0.85,
    }]);
    expect(updated.evidence.some(item => item.kind === "lookup")).toBe(true);
    const entity = updated.entities.find(item => item.original_name === "Elon Musk");
    expect(entity?.zh_name).toBe("埃隆·马斯克");
    expect(entity?.evidence_ids.some(id => id.startsWith("lookup-"))).toBe(true);
  });

  test("caps lookups and uses injected fetch", async () => {
    const hits = await lookupEntities(brief(), {
      fetch: async () => ({
        ok: true,
        json: async () => ["Elon Musk", ["埃隆·马斯克"], ["企业家"], ["https://zh.wikipedia.org/wiki/x"]],
      }),
    });
    expect(hits).toEqual([{
      query: "Elon Musk",
      original_name: "Elon Musk",
      zh_name: "埃隆·马斯克",
      summary_zh: "企业家",
      source_url: "https://zh.wikipedia.org/wiki/x",
      confidence: 0.85,
    }]);
  });
});
