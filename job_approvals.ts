import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync, readFileSync } from "fs";
import { dirname, join } from "path";
import type { ContentBrief } from "./metadata_quality";
import type { LookupHit } from "./entity_lookup";

export const APPROVALS_FILE = "pending_approvals.json";

export type ApprovalKind =
  | "uncertainty"
  | "low_confidence_entity"
  | "needs_review"
  | "lookup_name"
  | "forbidden_claim";

export interface ApprovalItem {
  id: string;
  kind: ApprovalKind;
  summary: string;
  acknowledged: boolean;
}

export interface ApprovalState {
  items: ApprovalItem[];
}

function slugPart(value: string, index: number): string {
  const compact = value.replace(/\s+/g, "").slice(0, 12) || String(index + 1);
  return compact;
}

export function buildApprovalItems(input: {
  brief?: ContentBrief | null;
  copyStatus?: string;
  reviewIssues?: string[];
  lookups?: readonly LookupHit[];
}): ApprovalItem[] {
  const items: ApprovalItem[] = [];
  const brief = input.brief;
  if (brief) {
    brief.uncertainties.forEach((item, index) => {
      const summary = item.trim();
      if (!summary) return;
      items.push({
        id: `uncertainty-${index + 1}-${slugPart(summary, index)}`,
        kind: "uncertainty",
        summary: `不确定：${summary}`,
        acknowledged: false,
      });
    });
    brief.entities.forEach((entity, index) => {
      if (entity.confidence >= 0.7) return;
      items.push({
        id: `entity-${index + 1}-${slugPart(entity.original_name, index)}`,
        kind: "low_confidence_entity",
        summary: `低置信实体：${entity.zh_name || entity.original_name}（${entity.original_name}，${entity.confidence}）`,
        acknowledged: false,
      });
    });
  }
  for (const hit of input.lookups || []) {
    items.push({
      id: `lookup-${hit.original_name}`,
      kind: "lookup_name",
      summary: `查证译名：${hit.original_name} → ${hit.zh_name}`,
      acknowledged: false,
    });
  }
  if (input.copyStatus === "needs_review") {
    const extra = (input.reviewIssues || []).filter(Boolean).slice(0, 3).join("；");
    items.push({
      id: "needs-review",
      kind: "needs_review",
      summary: extra ? `文案需要人工核对：${extra}` : "文案需要人工核对后再保存草稿",
      acknowledged: false,
    });
  }
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function unacknowledgedApprovals(items: readonly ApprovalItem[]): ApprovalItem[] {
  return items.filter(item => !item.acknowledged);
}

export function approvalsPath(artifactDir: string): string {
  return join(artifactDir, APPROVALS_FILE);
}

export function readApprovals(artifactDir: string): ApprovalState {
  const path = approvalsPath(artifactDir);
  if (!existsSync(path)) return { items: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (!raw || !Array.isArray(raw.items)) return { items: [] };
    return {
      items: raw.items.filter((item: unknown) => item && typeof item === "object") as ApprovalItem[],
    };
  } catch {
    return { items: [] };
  }
}

export function writeApprovals(artifactDir: string, items: ApprovalItem[]): ApprovalState {
  const state = { items };
  const path = approvalsPath(artifactDir);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, path);
  return state;
}

export function acknowledgeApprovals(artifactDir: string, ids: readonly string[]): ApprovalState {
  const wanted = new Set(ids);
  const current = readApprovals(artifactDir);
  const items = current.items.map(item => wanted.has(item.id) ? { ...item, acknowledged: true } : item);
  return writeApprovals(artifactDir, items);
}

export function replaceApprovalsPreservingAck(artifactDir: string, nextItems: ApprovalItem[]): ApprovalState {
  const previous = new Map(readApprovals(artifactDir).items.map(item => [item.id, item]));
  const merged = nextItems.map(item => {
    const old = previous.get(item.id);
    return old?.acknowledged ? { ...item, acknowledged: true } : item;
  });
  return writeApprovals(artifactDir, merged);
}

export function clearApprovals(artifactDir: string): void {
  const path = approvalsPath(artifactDir);
  try { unlinkSync(path); } catch {}
}
