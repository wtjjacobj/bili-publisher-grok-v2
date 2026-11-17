export interface MetadataChatPatch {
  reply?: string;
  title?: string;
  title_candidates?: string[];
  recommended_title_index?: number;
  tags?: string[];
  description?: string;
  tid?: number;
}

export function applyMetadataChatPatch(
  result: Record<string, unknown>,
  patch: MetadataChatPatch,
): { result: Record<string, unknown>; changed: string[] } {
  const next: Record<string, unknown> = { ...result };
  const changed: string[] = [];

  let titles = Array.isArray(next.title_candidates)
    ? (next.title_candidates as unknown[]).map(item => String(item))
    : [];
  if (Array.isArray(patch.title_candidates) && patch.title_candidates.length > 0) {
    titles = patch.title_candidates.map(item => String(item).trim()).filter(Boolean).slice(0, 5);
    if (titles.length === 0) throw new Error("调整后的标题不能为空");
    while (titles.length < 5) titles.push(titles[titles.length - 1]);
    next.title_candidates = titles;
    changed.push("标题候选");
  }

  if (typeof patch.title === "string" && patch.title.trim()) {
    const title = patch.title.trim();
    if ([...title].length > 80) throw new Error("标题不能超过80字");
    if (titles.length === 0) titles = [title, title, title, title, title];
    const recommended = Number.isInteger(next.recommended_title_index)
      ? Number(next.recommended_title_index)
      : 0;
    const index = Math.min(Math.max(recommended, 0), titles.length - 1);
    titles = [...titles];
    titles[index] = title;
    next.title_candidates = titles;
    next.recommended_title_index = index;
    changed.push("标题");
  }

  if (Number.isInteger(patch.recommended_title_index)) {
    const index = Number(patch.recommended_title_index);
    const count = Array.isArray(next.title_candidates) ? (next.title_candidates as unknown[]).length : 0;
    if (index < 0 || index >= count) throw new Error("推荐标题索引超出范围");
    next.recommended_title_index = index;
    changed.push("推荐标题");
  }

  if (Array.isArray(patch.tags)) {
    const tags = patch.tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 10);
    if (tags.length < 1) throw new Error("标签至少需要1个");
    if (tags.some(tag => [...tag].length > 20)) throw new Error("单个标签不能超过20字");
    next.tags = tags;
    changed.push("标签");
  }

  if (typeof patch.description === "string") {
    const description = patch.description.trim();
    if (description.length > 2000) throw new Error("简介不能超过2000字");
    next.description = description;
    changed.push("简介");
  }

  if (patch.tid !== undefined) {
    const tid = Number(patch.tid);
    if (!Number.isInteger(tid) || tid < 1 || tid > 9999) throw new Error("分区tid必须是1到9999的整数");
    next.tid = tid;
    changed.push("分区");
  }

  return { result: next, changed: [...new Set(changed)] };
}

export function chatPatchFromModel(value: unknown): MetadataChatPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Grok 没有返回可应用的JSON调整");
  }
  const raw = value as Record<string, unknown>;
  const patch: MetadataChatPatch = {};
  if (typeof raw.reply === "string") patch.reply = raw.reply.trim();
  if (typeof raw.title === "string") patch.title = raw.title;
  if (Array.isArray(raw.title_candidates)) patch.title_candidates = raw.title_candidates.map(String);
  if (Number.isInteger(raw.recommended_title_index)) {
    patch.recommended_title_index = Number(raw.recommended_title_index);
  }
  if (Array.isArray(raw.tags)) patch.tags = raw.tags.map(String);
  if (typeof raw.description === "string") patch.description = raw.description;
  if (raw.tid !== undefined && raw.tid !== null && raw.tid !== "") patch.tid = Number(raw.tid);
  return patch;
}
