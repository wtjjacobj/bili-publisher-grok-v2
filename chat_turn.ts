import {
  applyMetadataChatPatch,
  type MetadataChatPatch,
} from "./grok_chat";
import {
  assessMetadataAgainstBrief,
  hardSafetyIssues,
  type ContentBrief,
  type MetadataDraft,
} from "./metadata_quality";

export interface ChatTurnOutcome {
  result: Record<string, unknown>;
  changed: string[];
  issues: string[];
  hardIssues: string[];
  accepted: boolean;
  copyStatus: "approved" | "needs_review";
}

export function buildChatTurnPrompt(input: {
  brief: ContentBrief;
  result: Record<string, unknown>;
  message: string;
}): string {
  const brief = input.brief;
  return `你是B站投稿助手的文案调整模块。这是同一任务的下一轮，必须接着事实卡改，不能另开一轮脑补。
只能调整当前任务的标题、标签、简介和分区tid。不要投稿，不要谈ffmpeg，不要编造视频里没有的事实。
禁止写出 forbidden_claims 中的任何断言。来源账号不得写成作品名或人名。

事实卡:
${JSON.stringify({
    core_subject: brief.core_subject,
    core_event: brief.core_event,
    hook: brief.hook,
    turning_point: brief.turning_point,
    outcome: brief.outcome,
    entities: brief.entities,
    source_account: brief.source_account,
    uncertainties: brief.uncertainties,
    forbidden_claims: brief.forbidden_claims,
  }, null, 2)}

当前文案:
${JSON.stringify({
    title_candidates: input.result.title_candidates || [],
    recommended_title_index: input.result.recommended_title_index ?? 0,
    tags: input.result.tags || [],
    description: input.result.description || "",
    tid: input.result.tid || null,
    copy_status: input.result.copy_status || "",
    review_issues: input.result.review_issues || [],
    deterministic_issues: input.result.deterministic_issues || [],
  }, null, 2)}

用户要求: ${input.message.trim()}

只输出一个JSON对象，字段:
- reply: 给用户看的中文说明（必填）
- title: 只改推荐标题时填写
- title_candidates: 要整组替换时填写，最多5个
- recommended_title_index: 0到4
- tags: 1到10个标签
- description: 简介
- tid: 分区数字ID
没有要改的字段就省略。`;
}

export function draftFromResult(result: Record<string, unknown>, brief: ContentBrief): MetadataDraft {
  const titles = Array.isArray(result.title_candidates)
    ? result.title_candidates.map(item => String(item))
    : [];
  const tags = Array.isArray(result.tags) ? result.tags.map(item => String(item)) : [];
  const fallbackEvidence = [
    ...brief.hook_evidence_ids,
    ...brief.core_event_evidence_ids,
    ...brief.core_subject_evidence_ids,
  ].filter(Boolean);
  const uniqueEvidence = [...new Set(fallbackEvidence)];
  const titleReasons = Array.isArray(result.title_reasons) && result.title_reasons.length === titles.length
    ? result.title_reasons as MetadataDraft["title_reasons"]
    : titles.map((_, title_index) => ({
      title_index,
      evidence_ids: uniqueEvidence.slice(0, Math.max(1, uniqueEvidence.length)),
      reason: "改稿后按事实卡核心看点重新挂接证据",
    }));
  const tagEvidence = Array.isArray(result.tag_evidence) && result.tag_evidence.length === tags.length
    ? result.tag_evidence as MetadataDraft["tag_evidence"]
    : tags.map(tag => ({
      tag,
      evidence_ids: uniqueEvidence.slice(0, Math.max(1, uniqueEvidence.length)),
    }));
  return {
    title_candidates: titles,
    recommended_title_index: Number.isInteger(result.recommended_title_index)
      ? Number(result.recommended_title_index)
      : 0,
    title_reasons: titleReasons,
    tags,
    tag_evidence: tagEvidence,
    description: String(result.description || ""),
    tid: Number.isInteger(result.tid) ? Number(result.tid) : 21,
  };
}

export function refreshDraftEvidence(draft: MetadataDraft, brief: ContentBrief): MetadataDraft {
  const fallback = [...new Set([
    ...brief.hook_evidence_ids,
    ...brief.core_event_evidence_ids,
    ...brief.core_subject_evidence_ids,
  ].filter(Boolean))];
  const evidenceIds = fallback.length > 0 ? fallback : brief.evidence.slice(0, 1).map(item => item.id);
  return {
    ...draft,
    title_reasons: draft.title_candidates.map((_, title_index) => ({
      title_index,
      evidence_ids: [...evidenceIds],
      reason: "改稿后按事实卡核心看点重新挂接证据",
    })),
    tag_evidence: draft.tags.map(tag => ({
      tag,
      evidence_ids: [...evidenceIds],
    })),
  };
}

export function applyChatTurn(input: {
  result: Record<string, unknown>;
  brief: ContentBrief;
  patch: MetadataChatPatch;
}): ChatTurnOutcome {
  const applied = applyMetadataChatPatch(input.result, input.patch);
  if (applied.changed.length === 0) {
    return {
      result: applied.result,
      changed: [],
      issues: [],
      hardIssues: [],
      accepted: true,
      copyStatus: applied.result.copy_status === "needs_review" ? "needs_review" : "approved",
    };
  }
  const refreshed = refreshDraftEvidence(draftFromResult(applied.result, input.brief), input.brief);
  const next: Record<string, unknown> = {
    ...applied.result,
    ...refreshed,
  };
  const issues = assessMetadataAgainstBrief(refreshed, input.brief, {
    subtitle_file: String(next.subtitle_file || ""),
  });
  const hard = hardSafetyIssues(issues);
  if (hard.length > 0) {
    return {
      result: input.result,
      changed: [],
      issues,
      hardIssues: hard,
      accepted: false,
      copyStatus: input.result.copy_status === "needs_review" ? "needs_review" : "approved",
    };
  }
  const copyStatus = issues.length > 0 ? "needs_review" : "approved";
  next.copy_status = copyStatus;
  next.deterministic_issues = issues;
  if (issues.length > 0) {
    next.review_issues = issues;
  } else {
    next.review_issues = [];
  }
  return {
    result: next,
    changed: applied.changed,
    issues,
    hardIssues: [],
    accepted: true,
    copyStatus,
  };
}
