import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  acknowledgeApprovals,
  buildApprovalItems,
  readApprovals,
  replaceApprovalsPreservingAck,
  unacknowledgedApprovals,
} from "../job_approvals";
import type { ContentBrief } from "../metadata_quality";

const brief: ContentBrief = {
  video_type: "现场",
  core_subject: "派对",
  core_subject_evidence_ids: ["s"],
  core_event: "骑马",
  core_event_evidence_ids: ["s"],
  timeline: [{ time: 1, summary_zh: "马", evidence_ids: ["s"] }],
  turning_point: "",
  turning_point_evidence_ids: [],
  outcome: "",
  outcome_evidence_ids: [],
  hook: "马",
  hook_evidence_ids: ["s"],
  evidence: [{ id: "s", kind: "source", summary_zh: "原帖" }],
  entities: [
    { original_name: "Elon Musk", zh_name: "Elon Musk", type: "person", confidence: 0.4, evidence_ids: ["s"] },
  ],
  source_account: "Massimo",
  verified_dialogue: [],
  uncertainties: ["结尾马匹身份不明"],
  forbidden_claims: ["已添加中文字幕"],
};

describe("approvals", () => {
  test("builds uncertainty, low-confidence, lookup and review items", () => {
    const items = buildApprovalItems({
      brief,
      copyStatus: "needs_review",
      reviewIssues: ["标题空泛"],
      lookups: [{
        query: "Elon Musk",
        original_name: "Elon Musk",
        zh_name: "埃隆·马斯克",
        summary_zh: "企业家",
        source_url: "https://zh.wikipedia.org",
        confidence: 0.85,
      }],
    });
    expect(items.some(item => item.kind === "uncertainty")).toBe(true);
    expect(items.some(item => item.kind === "low_confidence_entity")).toBe(true);
    expect(items.some(item => item.kind === "lookup_name")).toBe(true);
    expect(items.some(item => item.kind === "needs_review")).toBe(true);
    expect(unacknowledgedApprovals(items)).toHaveLength(items.length);
  });

  test("keeps previous acknowledgements when rebuilding", () => {
    const directory = mkdtempSync(join(tmpdir(), "approvals-"));
    try {
      const first = buildApprovalItems({ brief, copyStatus: "needs_review" });
      replaceApprovalsPreservingAck(directory, first);
      acknowledgeApprovals(directory, [first[0].id]);
      const rebuilt = replaceApprovalsPreservingAck(directory, buildApprovalItems({ brief, copyStatus: "needs_review" }));
      expect(rebuilt.items[0].acknowledged).toBe(true);
      expect(readApprovals(directory).items[0].acknowledged).toBe(true);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
