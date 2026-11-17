export interface ContentEvidence {
  id: string;
  kind: "source" | "frame" | "transcript" | "lookup";
  summary_zh: string;
}

export interface ContentTimelineItem {
  time: number;
  summary_zh: string;
  evidence_ids: string[];
}

export type ContentEntityType = "person" | "work" | "location" | "brand" | "event" | "organization" | "other";

export interface ContentEntity {
  original_name: string;
  zh_name: string;
  type: ContentEntityType;
  confidence: number;
  evidence_ids: string[];
}

export interface VerifiedDialogue {
  text_original: string;
  text_zh: string;
  speaker: string;
  evidence_ids: string[];
}

export interface ContentBrief {
  video_type: string;
  core_subject: string;
  core_subject_evidence_ids: string[];
  core_event: string;
  core_event_evidence_ids: string[];
  timeline: ContentTimelineItem[];
  turning_point: string;
  turning_point_evidence_ids: string[];
  outcome: string;
  outcome_evidence_ids: string[];
  hook: string;
  hook_evidence_ids: string[];
  evidence: ContentEvidence[];
  entities: ContentEntity[];
  source_account: string;
  verified_dialogue: VerifiedDialogue[];
  uncertainties: string[];
  forbidden_claims: string[];
}

export interface MetadataTitleReason {
  title_index: number;
  evidence_ids: string[];
  reason: string;
}

export interface MetadataTagEvidence {
  tag: string;
  evidence_ids: string[];
}

export interface MetadataDraft {
  title_candidates: string[];
  recommended_title_index: number;
  title_reasons: MetadataTitleReason[];
  tags: string[];
  tag_evidence: MetadataTagEvidence[];
  description: string;
  tid: number;
}

export interface MetadataReviewScores {
  grounding: number;
  relevance: number;
  specificity: number;
  chinese_naturalness: number;
  appeal: number;
}

export interface MetadataReview {
  approved: boolean;
  scores: MetadataReviewScores;
  issues: string[];
  rewrite_instructions: string[];
}

/**
 * Result-assembly facts that are not part of the content brief.
 *
 * This argument is optional so existing two-argument callers remain valid.
 * Pass it whenever the assembled result is available so subtitle claims can
 * be checked against the actual subtitle file state.
 */
export interface MetadataAssemblyContext {
  subtitle_file?: string | null;
}

const GENERIC_TITLE_PATTERN = /发生了什么|接下来会怎样|现场画面|为何这样/;
const ENUMERATION_TITLE_PATTERN = /全融合|全部叠在一起|从头到尾|完整剧情/;
/** Category tags express genre, not a frame-level claim, so they carry no evidence. */
const MAX_CATEGORY_TAGS = 4;
/**
 * Traffic-pool keywords on Bilibili. Each names a genre rather than something
 * visible in a frame, so it needs no evidence link and may coexist with the more
 * specific tag it appears inside. Anything outside this vocabulary is treated as
 * a claim, which keeps invented names like a character who is not in the video
 * from slipping through as an unevidenced tag.
 */
const CATEGORY_TAG_VOCABULARY = new Set([
  "ai视频", "ai生成", "ai恶搞", "ai动画", "ai绘画", "aigc", "ai短剧",
  "沙雕动画", "沙雕", "沙雕视频", "鬼畜", "恶搞", "恶搞视频", "搞笑",
  "搞笑视频", "meme", "梗视频", "整活", "短剧",
  "影视混剪", "混剪", "剪辑", "影视剪辑", "二创", "名场面", "高能",
  "游戏", "游戏视频", "游戏集锦", "单机游戏", "模拟器", "主机游戏",
  "二次元", "动漫", "动画", "cosplay",
  "音乐", "翻唱", "舞蹈",
  "科技", "数码", "汽车", "赛车", "车祸集锦",
  "生活", "日常", "vlog", "美食", "宠物", "动物",
  "影视", "电影", "电视剧", "综艺", "纪录片",
  "国际", "社会", "资讯", "政治讽刺", "讽刺",
  "体育", "运动", "健身", "知识", "科普",
]);
/**
 * Fact cards forbid presenting parody as real footage, which models over-satisfy
 * by asserting the inverse in the description. The disclaimer spends the first
 * 80 characters Bilibili shows in search results and gives the joke away, so the
 * AI nature belongs in a tag instead.
 */
const COPY_DISCLAIMER_PATTERNS = [
  /本片(?:为|是|系)[^。；]{0,12}?AI/i,
  /本片(?:为|是|系)虚构/,
  /非真实(?:影像|画面|纪录|记录|事件)/,
  /不是真实(?:的)?[^。；]{0,6}?(?:影像|画面|纪录|记录|事件)/,
  /(?:人物|形象)[^。；]{0,6}?(?:均|都)?(?:为|是)生成形象/,
];
/** Occupations and titles are not proper names, so the Chinese-name rule skips them. */
const ROLE_NAME_TOKENS = new Set([
  "chief", "police", "officer", "detective", "sergeant", "captain", "commissioner",
  "lieutenant", "senator", "congressman", "president", "mayor", "governor", "judge",
  "attorney", "agent", "doctor", "professor", "coach", "driver", "pilot", "host",
  "anchor", "reporter", "journalist", "bride", "groom", "guest", "narrator",
  "singer", "dancer", "player", "chef", "waiter", "manager", "guard", "soldier",
  "nurse", "teacher", "student", "worker", "staff", "boss", "founder", "department",
]);
const ENTITY_TYPES = new Set<ContentEntityType>([
  "person", "work", "location", "brand", "event", "organization", "other",
]);
/**
 * The analyzer reports how sure it is about each identity it recognises. A guess
 * made from someone's appearance must not turn into a flat claim in the copy, so
 * a name is only assertable in titles and descriptions above the higher bar, and
 * below the lower bar it cannot be used at all.
 *
 * Works sit lower than people. Most of the doubt in a film's score is about which
 * installment it is rather than which franchise, and titles carry the franchise
 * name, which survives getting the installment wrong. Naming the wrong real person
 * has no such margin.
 */
const ENTITY_ASSERTABLE_CONFIDENCE = 0.9;
const ENTITY_ASSERTABLE_WORK_CONFIDENCE = 0.8;
const ENTITY_TAGGABLE_CONFIDENCE = 0.7;
const GENERIC_LATIN_NAME_TOKENS = new Set([
  "the", "and", "of", "de", "da", "di", "la", "le", "van", "von",
  "jr", "sr", "mr", "ms", "dr", "sir", "lady", "lord", "doctor",
  "person", "people", "man", "woman",
]);
/**
 * Words that never identify what a hook is about. Content words are already
 * dropped when they also appear in the fact card's subject line, so leaving
 * decorative ones in makes them the required anchors and rejects a rewording
 * that covers the hook perfectly well.
 */
const GENERIC_HOOK_TOKENS = new Set([
  "视频", "画面", "现场", "记录", "内容", "片段", "短片", "镜头",
  "开头", "结尾", "出现", "进入", "转向", "过程", "结果", "主体",
  "事件", "看点", "人群", "舞台", "场景", "活动", "有人",
  "瞬间", "一瞬", "时刻", "那刻", "高高", "深深", "紧紧", "远远",
  "突然", "忽然", "随即", "随后", "接着", "然后", "最后", "最终",
  "直接", "反复", "不断", "继续", "整个", "全程", "同时", "中间",
  "特写", "近景", "远景", "前后", "左右", "上下", "一直", "始终",
]);
const ZH_WORD_SEGMENTER = new Intl.Segmenter("zh-CN", { granularity: "word" });
const HORSE_CONCEPT_ALIASES = ["骑马", "马匹", "马儿", "马群", "匹马", "骏马"];
const HORSE_HOOK_CONTEXTS = ["马进入", "马走进", "马穿过", "马出现"];
const ACCOUNT_IDENTITY_EVIDENCE_IDS = new Set([
  "source-uploader",
  "source-channel",
  "source-source-account",
  "source-account",
]);

function isIndependentContentEvidenceId(id: string): boolean {
  return id === "source-title"
    || id === "source-description"
    || /^frame-\d+$/.test(id)
    || /^transcript-\d+$/.test(id);
}

function publicationText(draft: MetadataDraft): string {
  return [...draft.title_candidates, ...draft.tags, draft.description].join("\n");
}

function normalizedTag(tag: string): string {
  return tag.normalize("NFKC").trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * A tag counts as a genre label when it is a known traffic-pool keyword or when
 * the fact card's own video_type already contains it. Chinese genre words also
 * compound freely (高能 + 名场面, 好莱坞 + 电影), and an exact lookup would reject
 * those compounds even though they classify rather than assert, so a trailing
 * head word counts too. MAX_CATEGORY_TAGS stays the cap that bounds how much
 * unevidenced text can reach a draft.
 */
function isCategoryTag(tag: string, videoType: string): boolean {
  const normalized = normalizedTag(tag);
  if (!normalized) return false;
  if (CATEGORY_TAG_VOCABULARY.has(normalized)) return true;
  for (const word of CATEGORY_TAG_VOCABULARY) {
    if (word.length >= 2 && normalized.length > word.length && normalized.endsWith(word)) return true;
  }
  return normalized.length >= 2 && normalizedTag(String(videoType || "")).includes(normalized);
}

function textAnchors(text: string): Set<string> {
  const words = [...ZH_WORD_SEGMENTER.segment(text.normalize("NFKC"))]
    .filter(segment => segment.isWordLike)
    .map(segment => normalizedTag(segment.segment))
    .filter(Boolean);
  const anchors = new Set<string>();
  for (const word of words) {
    if (word.length >= 2 && !GENERIC_HOOK_TOKENS.has(word)) anchors.add(word);
  }
  return anchors;
}

function groupedIndependentConcepts(anchors: string[]): string[][] {
  const groups: string[][] = [];
  for (const anchor of [...new Set(anchors)].sort((left, right) => right.length - left.length)) {
    const overlappingGroup = groups.find(group => group.some(
      alias => alias.includes(anchor) || anchor.includes(alias),
    ));
    if (overlappingGroup) overlappingGroup.push(anchor);
    else groups.push([anchor]);
  }
  return groups;
}

function evidenceBackedHookCoverage(
  brief: ContentBrief,
  evidenceIds: Set<string>,
): { concepts: string[][]; minimumMatches: number } {
  if (!brief.hook.trim() || brief.hook_evidence_ids.length === 0
    || brief.hook_evidence_ids.some(id => !evidenceIds.has(id))) return { concepts: [], minimumMatches: 0 };
  const hookEvidenceIds = new Set(brief.hook_evidence_ids);
  const overlapsHookEvidence = (ids: string[]): boolean => ids.some(id => hookEvidenceIds.has(id));
  const linkedTexts = [
    brief.hook,
    ...brief.evidence.filter(item => hookEvidenceIds.has(item.id)).map(item => item.summary_zh),
    ...(overlapsHookEvidence(brief.core_event_evidence_ids) ? [brief.core_event] : []),
    ...(overlapsHookEvidence(brief.turning_point_evidence_ids) ? [brief.turning_point] : []),
    ...(overlapsHookEvidence(brief.outcome_evidence_ids) ? [brief.outcome] : []),
    ...brief.timeline.filter(item => overlapsHookEvidence(item.evidence_ids)).map(item => item.summary_zh),
  ].map(value => value.trim()).filter(Boolean);
  const baselineText = normalizedTag(`${brief.video_type}${brief.core_subject}`);
  const baselineAnchors = new Set([
    ...textAnchors(brief.video_type),
    ...textAnchors(brief.core_subject),
  ]);
  const hookAnchors = textAnchors(brief.hook);
  const counts = new Map<string, number>();
  for (const text of linkedTexts) {
    for (const anchor of textAnchors(text)) counts.set(anchor, (counts.get(anchor) || 0) + 1);
  }
  const eligibleAnchors = [...counts.entries()]
    .filter(([anchor, count]) => (count >= 2 || hookAnchors.has(anchor))
      && !baselineAnchors.has(anchor)
      && !baselineText.includes(anchor))
    .map(([anchor]) => anchor)
    .sort((left, right) => right.length - left.length);
  const primaryAnchors = [...hookAnchors]
    .filter(anchor => eligibleAnchors.includes(anchor))
    .sort((left, right) => right.length - left.length);
  const normalizedHook = normalizedTag(brief.hook);
  const hookSignalsHorse = [...HORSE_CONCEPT_ALIASES, ...HORSE_HOOK_CONTEXTS]
    .some(alias => normalizedHook.includes(alias));
  const evidenceLinkedHorseConcept = hookSignalsHorse && linkedTexts.some(text => {
    const normalized = normalizedTag(text);
    return HORSE_CONCEPT_ALIASES.some(alias => normalized.includes(alias));
  });
  const isHorseAlias = (anchor: string): boolean => HORSE_CONCEPT_ALIASES.some(
    alias => alias.includes(anchor) || anchor.includes(alias),
  );
  const primaryConcepts = groupedIndependentConcepts(
    primaryAnchors.filter(anchor => !evidenceLinkedHorseConcept || !isHorseAlias(anchor)),
  );
  if (evidenceLinkedHorseConcept) primaryConcepts.unshift(HORSE_CONCEPT_ALIASES);
  const concepts = primaryConcepts.length > 0
    ? primaryConcepts
    : groupedIndependentConcepts(eligibleAnchors);
  return { concepts, minimumMatches: concepts.length >= 2 ? 2 : concepts.length };
}

function flexibleLiteralPattern(value: string): string {
  const words = value.normalize("NFKC").trim().split(/[\s\p{P}\p{S}]+/gu).filter(Boolean);
  return words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\p{P}\\p{S}]*");
}

function sourceAccountMiscastAsWork(
  draft: MetadataDraft,
  brief: ContentBrief,
  evidenceIds: Set<string>,
): boolean {
  const account = brief.source_account.trim();
  if (!account) return false;
  const normalizedAccount = normalizedTag(account);
  const hasConfirmedWork = brief.entities.some(entity => entity.type === "work"
    && entity.evidence_ids.length > 0
    && entity.evidence_ids.every(id => evidenceIds.has(id))
    && entity.evidence_ids.some(id => (
      !ACCOUNT_IDENTITY_EVIDENCE_IDS.has(id) && isIndependentContentEvidenceId(id)
    ))
    && [entity.original_name, entity.zh_name].some(name => normalizedTag(name) === normalizedAccount));
  if (hasConfirmedWork) return false;
  const accountPattern = flexibleLiteralPattern(account);
  if (!accountPattern) return false;
  const workNoun = "(?:电影片段|影视片段|电视剧片段|影集片段|电影|影片|剧集|电视剧|影集|作品|影剧)";
  const quotedAccount = `(?:\"\\s*${accountPattern}\\s*\"|“\\s*${accountPattern}\\s*”|「\\s*${accountPattern}\\s*」|『\\s*${accountPattern}\\s*』|'\\s*${accountPattern}\\s*'|‘\\s*${accountPattern}\\s*’|【\\s*${accountPattern}\\s*】)`;
  const namedAccount = `(?:${accountPattern}|${quotedAccount}|《\\s*${accountPattern}\\s*》)`;
  const misusePattern = new RegExp([
    `《\\s*${accountPattern}\\s*》`,
    `${quotedAccount}\\s*(?:的\\s*)?${workNoun}`,
    `${workNoun}\\s*${quotedAccount}`,
    `${accountPattern}\\s*(?:的\\s*)?(?:被称为|就是|是|作为)?\\s*${workNoun}`,
    `${workNoun}\\s*(?:名为|叫做|《)?\\s*${accountPattern}`,
    `(?:名叫|名为)\\s*${namedAccount}\\s*的\\s*${workNoun}`,
    `(?:片名|剧名)\\s*(?:(?:是|为|叫做|名为|名叫)|[:：])?\\s*${namedAccount}`,
  ].join("|"), "iu");
  return [...draft.title_candidates, draft.description]
    .some(text => misusePattern.test(text.normalize("NFKC")));
}

function hasUnsupportedSubtitleClaim(text: string): boolean {
  const subtitleNoun = "(?:中文|中英)?(?:双字|字幕)";
  const withoutExplicitNegations = text
    .replace(new RegExp(
      `(?:没有|并未|不曾|不会|尚未|还未|未|无|不)(?:实际)?(?:自带|包含|添加|生成|制作|烧录|内嵌|配备|配有|带有|附有|提供|配|有)?(?:任何)?${subtitleNoun}`,
      "g",
    ), "")
    .replace(new RegExp(
      `${subtitleNoun}(?:(?:尚未|还未|并未|未|没有)(?:上线|可用|可看)|不可用|不可看|不能用|不能看)`,
      "g",
    ), "");
  return new RegExp([
    `(?:^|\\n)\\s*${subtitleNoun}\\s*(?:\\n|$)`,
    "字幕版|双字版|中英双字|中英字幕",
    `(?:自带|包含|配有|带有|附有|提供|有|配)(?:了|有)?${subtitleNoun}`,
    `(?:已|已经|现已)?(?:添加|生成|制作|烧录|内嵌|配备)(?:了|有)?${subtitleNoun}`,
    `${subtitleNoun}(?:已|已经|现已)(?:被)?(?:添加|生成|制作|烧录|内嵌|上线)`,
    `${subtitleNoun}(?:可用|可看)`,
  ].join("|")).test(withoutExplicitNegations);
}

function latinWords(text: string): string[] {
  return text.normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/\p{M}/gu, "")
    .match(/[a-z0-9]+/g) || [];
}

function meaningfulLatinPersonAliases(entity: ContentEntity): string[] {
  return latinWords(entity.original_name).filter(
    token => token.length >= 3 && !GENERIC_LATIN_NAME_TOKENS.has(token),
  );
}

function hasConfirmedChineseName(value: string): boolean {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

/**
 * True when every significant token is an occupation or title, e.g. "Chief of
 * Police". Such entries name a role rather than a person, so requiring the
 * Chinese rendering of them flags ordinary wording as a naming violation.
 */
function isRoleName(value: string): boolean {
  const tokens = latinWords(value);
  if (tokens.length === 0) return false;
  return tokens.every(token => ROLE_NAME_TOKENS.has(token));
}

export function hardSafetyIssues(issues: readonly string[]): string[] {
  return issues.filter(issue => (
    issue.startsWith("文案包含事实卡明确禁止的断言")
    || issue.startsWith("来源账号被当作作品或影视片名")
    || issue === "未生成字幕却声称包含字幕或翻译"
  ));
}

function usesLatinPersonName(text: string, entity: ContentEntity): boolean {
  const originalWords = latinWords(entity.original_name);
  if (originalWords.length === 0) return false;
  const metadataWords = latinWords(text);
  const normalizedMetadata = ` ${metadataWords.join(" ")} `;
  const normalizedOriginal = ` ${originalWords.join(" ")} `;
  if (normalizedMetadata.includes(normalizedOriginal)) return true;
  const meaningfulAliases = meaningfulLatinPersonAliases(entity);
  const metadataWordSet = new Set(metadataWords);
  return meaningfulAliases.some(alias => metadataWordSet.has(alias));
}

function assertableConfidenceFor(entity: ContentEntity): number {
  return entity.type === "work" ? ENTITY_ASSERTABLE_WORK_CONFIDENCE : ENTITY_ASSERTABLE_CONFIDENCE;
}

/**
 * Fact cards name the exact installment (变形金刚4：绝迹重生), but viewers search the
 * franchise, and the franchise is the part the analyzer is surest about. Titles
 * therefore carry the series name while tags keep the full one.
 */
export function seriesBaseName(workName: string): string {
  const trimmed = String(workName || "").normalize("NFKC").trim();
  if (!trimmed) return "";
  const beforeSubtitle = trimmed.split(/[：:—–]/)[0].trim();
  const withoutInstallment = beforeSubtitle
    .replace(/\s*第?\s*[0-9０-９一二三四五六七八九十]+\s*(?:部|季|集)?$/u, "")
    .trim();
  return withoutInstallment || beforeSubtitle || trimmed;
}

function mentionsEntityName(text: string, entity: ContentEntity): boolean {
  const zhName = entity.zh_name.normalize("NFKC").trim();
  if (zhName.length >= 2 && /\p{Script=Han}/u.test(zhName) && text.normalize("NFKC").includes(zhName)) {
    return true;
  }
  return usesLatinPersonName(text, entity);
}

function factChunks(text: string, minLength = 4): string[] {
  return [...String(text || "").matchAll(/[\u4e00-\u9fffA-Za-z0-9]{4,}/g)]
    .map(match => match[0])
    .filter(chunk => chunk.length >= minLength);
}

function unusedFactChunks(text: string, minusTexts: string[]): string[] {
  const minus = minusTexts.join("\n");
  return factChunks(text).filter(chunk => !minus.includes(chunk));
}

export function titleLooksLikeEnumeration(title: string): boolean {
  if (ENUMERATION_TITLE_PATTERN.test(title)) return true;
  const pauseMarks = title.match(/、/g) || [];
  return pauseMarks.length >= 2;
}

export function unusedOutcomeChunks(brief: ContentBrief): string[] {
  return unusedFactChunks(brief.outcome, [
    brief.hook,
    brief.core_event,
    brief.timeline[0]?.summary_zh || "",
  ]);
}

export function titleSpoilsUnusedOutcome(title: string, brief: ContentBrief): boolean {
  return unusedOutcomeChunks(brief).some(chunk => title.includes(chunk));
}

export function titleCoversOpeningAndEnding(title: string, brief: ContentBrief): boolean {
  const earlySource = brief.timeline[0]?.summary_zh || brief.hook;
  const earlyChunks = unusedFactChunks(earlySource, [brief.outcome]);
  if (earlyChunks.length === 0 || unusedOutcomeChunks(brief).length === 0) return false;
  return earlyChunks.some(chunk => title.includes(chunk)) && titleSpoilsUnusedOutcome(title, brief);
}

function validateEvidenceReferences(
  label: string,
  references: string[],
  evidenceIds: Set<string>,
  issues: string[],
): void {
  if (!Array.isArray(references) || references.length === 0) {
    issues.push(`${label}缺少证据引用`);
    return;
  }
  for (const evidenceId of references) {
    if (!evidenceIds.has(evidenceId)) issues.push(`${label}引用了未知证据：${evidenceId}`);
  }
}

function validateOptionalFactEvidence(
  label: string,
  fact: string,
  references: string[],
  evidenceIds: Set<string>,
  issues: string[],
): void {
  if (fact.trim() || references.length > 0) {
    validateEvidenceReferences(label, references, evidenceIds, issues);
  }
}

export function assessMetadataAgainstBrief(
  draft: MetadataDraft,
  brief: ContentBrief,
  assemblyContext?: MetadataAssemblyContext,
): string[] {
  const issues: string[] = [];
  const evidenceIds = new Set<string>();
  for (const item of brief.evidence) {
    if (evidenceIds.has(item.id)) issues.push(`事实卡证据ID重复：${item.id}`);
    evidenceIds.add(item.id);
  }
  validateEvidenceReferences("核心主体", brief.core_subject_evidence_ids, evidenceIds, issues);
  validateEvidenceReferences("核心事件", brief.core_event_evidence_ids, evidenceIds, issues);
  validateOptionalFactEvidence("转折", brief.turning_point, brief.turning_point_evidence_ids, evidenceIds, issues);
  validateOptionalFactEvidence("结果", brief.outcome, brief.outcome_evidence_ids, evidenceIds, issues);
  validateEvidenceReferences("看点", brief.hook_evidence_ids, evidenceIds, issues);
  brief.timeline.forEach((item, index) => {
    validateEvidenceReferences(`时间线第${index + 1}项`, item.evidence_ids, evidenceIds, issues);
  });
  brief.entities.forEach((entity, index) => {
    validateEvidenceReferences(`实体第${index + 1}项`, entity.evidence_ids, evidenceIds, issues);
  });
  brief.verified_dialogue.forEach((dialogue, index) => {
    validateEvidenceReferences(`对白第${index + 1}项`, dialogue.evidence_ids, evidenceIds, issues);
  });

  if (draft.title_candidates.length !== 5) issues.push("标题候选必须恰好5个");
  if (draft.title_candidates.some(title => title.length < 6 || title.length > 40)) {
    issues.push("标题候选长度必须为6到40个字符");
  }
  if (new Set(draft.title_candidates.map(title => title.trim())).size !== draft.title_candidates.length) {
    issues.push("标题候选不能重复");
  }
  if (draft.tags.length !== 10) issues.push("标签必须恰好10个");
  if (draft.tags.some(tag => tag.length < 1 || tag.length > 20)) {
    issues.push("标签长度必须为1到20个字符");
  }
  if (draft.description.length < 60 || draft.description.length > 1000) {
    issues.push("简介长度必须为60到1000个字符");
  }
  if (!Number.isInteger(draft.tid) || draft.tid < 1 || draft.tid > 9999) {
    issues.push("B站分区tid必须是1到9999之间的整数");
  }

  if (!Number.isInteger(draft.recommended_title_index)
    || draft.recommended_title_index < 0
    || draft.recommended_title_index >= draft.title_candidates.length) {
    issues.push("推荐标题索引必须指向现有候选标题");
  }

  const titleReasonCounts = new Map<number, number>();
  for (const reason of draft.title_reasons) {
    titleReasonCounts.set(reason.title_index, (titleReasonCounts.get(reason.title_index) || 0) + 1);
    if (reason.evidence_ids.length === 0) issues.push(`标题${reason.title_index + 1}缺少证据引用`);
    for (const evidenceId of reason.evidence_ids) {
      if (!evidenceIds.has(evidenceId)) issues.push(`标题依据引用了未知证据：${evidenceId}`);
    }
  }
  const titleReasonsCoverCandidates = draft.title_candidates.every(
    (_, index) => titleReasonCounts.get(index) === 1,
  ) && draft.title_reasons.every(
    reason => Number.isInteger(reason.title_index)
      && reason.title_index >= 0
      && reason.title_index < draft.title_candidates.length,
  );
  if (!titleReasonsCoverCandidates) issues.push("每个标题候选必须且只能有一条依据");

  const tagEvidenceCounts = new Map<string, number>();
  let categoryTagCount = 0;
  for (const record of draft.tag_evidence) {
    tagEvidenceCounts.set(record.tag, (tagEvidenceCounts.get(record.tag) || 0) + 1);
    if (record.evidence_ids.length === 0) {
      if (isCategoryTag(record.tag, brief.video_type)) categoryTagCount += 1;
      else issues.push(`标签缺少证据引用：${record.tag}`);
    }
    for (const evidenceId of record.evidence_ids) {
      if (!evidenceIds.has(evidenceId)) issues.push(`标签依据引用了未知证据：${evidenceId}`);
    }
  }
  if (categoryTagCount > MAX_CATEGORY_TAGS) {
    issues.push(`最多${MAX_CATEGORY_TAGS}个品类标签可以不带证据，当前有${categoryTagCount}个`);
  }
  const tagEvidenceCoversTags = draft.tags.every(tag => tagEvidenceCounts.get(tag) === 1)
    && draft.tag_evidence.every(record => draft.tags.includes(record.tag));
  if (!tagEvidenceCoversTags) issues.push("每个标签必须且只能有一条依据");

  const assertionText = [...draft.title_candidates, draft.description].join("\n");
  const tagText = draft.tags.join("\n");
  for (const entity of brief.entities) {
    if (!Number.isFinite(entity.confidence)) continue;
    const name = entity.zh_name.trim() || entity.original_name.trim();
    const score = entity.confidence.toFixed(2);
    // 系列名比完整片名弱一档，所以要单独判：标题写「变形金刚」和写
    // 「变形金刚4：绝迹重生」不是同一个断言，前者集数猜错也依然成立。
    const series = entity.type === "work" ? seriesBaseName(name) : "";
    const seriesUsed = (text: string) => series.length >= 2 && text.normalize("NFKC").includes(series);

    if (entity.confidence < ENTITY_TAGGABLE_CONFIDENCE) {
      if (mentionsEntityName(assertionText, entity) || mentionsEntityName(tagText, entity)
        || seriesUsed(assertionText) || seriesUsed(tagText)) {
        issues.push(`事实卡对「${name}」只有${score}的把握，不能写进文案`);
      }
      continue;
    }
    if (entity.confidence < assertableConfidenceFor(entity) && mentionsEntityName(assertionText, entity)) {
      issues.push(entity.type === "work"
        ? `事实卡对「${name}」只有${score}的把握，标题和简介只能写系列名「${series}」，完整片名留给标签`
        : `事实卡对「${name}」只有${score}的把握，只能当标签，不能写进标题或简介`);
    }
  }

  // 观众看影视片段第一个问题就是「这是哪部」，而系列名是全片最值钱的搜索词。
  // 门槛用的是「能不能用」的总下限而不是完整片名的断言档：分数里的犹豫多半针对集数，
  // 系列名本身容错高，否则同一条片子会因为 0.78 和 0.88 的抖动而时强制时不强制。
  const usableWork = brief.entities.find(entity => entity.type === "work"
    && Number.isFinite(entity.confidence)
    && entity.confidence >= ENTITY_TAGGABLE_CONFIDENCE);
  if (usableWork) {
    const series = seriesBaseName(usableWork.zh_name || usableWork.original_name);
    if (series.length >= 2 && !draft.title_candidates.join("\n").normalize("NFKC").includes(series)) {
      issues.push(`已识别作品「${series}」，5个标题必须至少有一个带上它`);
    }
  }

  const metadataText = publicationText(draft);
  for (const entity of brief.entities) {
    const entityType = String(entity.type);
    if (!ENTITY_TYPES.has(entityType as ContentEntityType)) issues.push(`事实卡实体类型无效：${entityType}`);
    const personLikeType = entityType === "person"
      || entityType.toLocaleLowerCase() === "person"
      || entityType === "人物";
    if (!personLikeType || isRoleName(entity.original_name)) continue;
    if (!usesLatinPersonName(metadataText, entity)) continue;
    if (hasConfirmedChineseName(entity.zh_name)) {
      issues.push(`人物名未使用已确认的中文名称：${entity.zh_name.trim()}`);
    }
  }

  for (let leftIndex = 0; leftIndex < draft.tags.length; leftIndex += 1) {
    const left = normalizedTag(draft.tags[leftIndex]);
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < draft.tags.length; rightIndex += 1) {
      const right = normalizedTag(draft.tags[rightIndex]);
      if (!right) continue;
      const leftIsShorter = left.length <= right.length;
      const shorter = leftIsShorter ? left : right;
      const longer = leftIsShorter ? right : left;
      // 系列名和具体某一部要同时留着：一个拉广域流量，一个做精准推荐，
      // 和「火影忍者」与「鸣人」共存是同一回事，不是凑数。
      const isSeriesOfInstallment = shorter === normalizedTag(
        seriesBaseName(draft.tags[leftIsShorter ? rightIndex : leftIndex]),
      );
      const isPadding = left === right
        || (longer.includes(shorter)
          && !isSeriesOfInstallment
          && !isCategoryTag(shorter, brief.video_type));
      if (isPadding) {
        issues.push(`标签重复或语义过近：${draft.tags[leftIndex]} / ${draft.tags[rightIndex]}`);
      }
    }
  }

  const groundingPhrases = [brief.core_subject, brief.core_event, brief.hook]
    .map(value => value.trim())
    .filter(Boolean);
  for (const [index, title] of draft.title_candidates.entries()) {
    if (GENERIC_TITLE_PATTERN.test(title)
      && !groundingPhrases.some(phrase => title.includes(phrase))) {
      issues.push(`标题空泛且未包含已确认的主体、事件或看点：${title}`);
    }
    if (titleLooksLikeEnumeration(title)) {
      issues.push(`标题像清单概述而不是钩子：${title}`);
    }
    if (titleCoversOpeningAndEnding(title, brief)) {
      issues.push(`标题把开头和结局写进同一句，变成概述全文：${title}`);
    }
    if (index === draft.recommended_title_index && titleSpoilsUnusedOutcome(title, brief)) {
      issues.push(`推荐标题剧透了结局，缺少信息缺口：${title}`);
    }
  }

  const hookCoverage = evidenceBackedHookCoverage(brief, evidenceIds);
  if (hookCoverage.minimumMatches > 0) {
    const titleAndDescription = normalizedTag([...draft.title_candidates, draft.description].join("\n"));
    const matchCount = hookCoverage.concepts.filter(aliases => aliases.some(
      alias => titleAndDescription.includes(alias),
    )).length;
    if (matchCount < hookCoverage.minimumMatches) {
      issues.push(`文案遗漏事实卡已确认的核心看点：${brief.hook.trim()}`);
    }
  }

  if (sourceAccountMiscastAsWork(draft, brief, evidenceIds)) {
    issues.push(`来源账号被当作作品或影视片名：${brief.source_account.trim()}`);
  }

  for (const forbiddenClaim of brief.forbidden_claims) {
    const claim = forbiddenClaim.trim();
    if (claim && metadataText.includes(claim)) {
      issues.push(`文案包含事实卡明确禁止的断言：${claim}`);
    }
  }

  if (assemblyContext !== undefined
    && !assemblyContext.subtitle_file?.trim()
    && hasUnsupportedSubtitleClaim(metadataText)) {
    issues.push("未生成字幕却声称包含字幕或翻译");
  }

  if (COPY_DISCLAIMER_PATTERNS.some(pattern => pattern.test(draft.description))) {
    issues.push("简介写了AI免责声明，占用搜索展示位并把梗说破，AI属性改用标签表达");
  }

  return [...new Set(issues)];
}

/**
 * Grounding accepts 4 so that genre framing and colloquial phrasing no longer
 * force a rewrite; fabricated claims still land at 3 or below. Appeal is a gate
 * rather than a collected-and-discarded score, so copy nobody would click gets
 * sent back the same way a factual error does.
 */
export function reviewIsApproved(review: MetadataReview): boolean {
  return review.approved === true
    && review.scores.grounding >= 4
    && review.scores.relevance >= 4
    && review.scores.specificity >= 4
    && review.scores.chinese_naturalness >= 4
    && review.scores.appeal >= 4
    && review.issues.length === 0;
}

export function buildConservativeDraft(
  brief: ContentBrief,
  draft: MetadataDraft,
): MetadataDraft {
  const clean = (value: string): string => {
    let localized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
    for (const entity of brief.entities) {
      if (entity.type !== "person") continue;
      const originalWords = latinWords(entity.original_name);
      if (originalWords.length === 0) continue;
      const replacement = entity.zh_name.trim() || "视频中的人物";
      const fullAliasPattern = originalWords
        .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^A-Za-z0-9]+");
      localized = localized.replace(
        new RegExp(`(?<![A-Za-z0-9])${fullAliasPattern}(?![A-Za-z0-9])`, "gi"),
        replacement,
      );
      const aliases = meaningfulLatinPersonAliases(entity);
      for (const alias of aliases) {
        const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        localized = localized.replace(
          new RegExp(`(?<![A-Za-z0-9])${escapedAlias}(?![A-Za-z0-9])`, "gi"),
          replacement,
        );
      }
    }
    return localized;
  };
  const uniqueIds = (...groups: string[][]): string[] => [...new Set(groups.flat())];
  const boundedTitle = (parts: string[]): string => {
    const factText = parts.map(clean).filter(Boolean).join("：");
    let title = factText;
    while ([...title].length < 6) title += "看点";
    return [...title].slice(0, 40).join("");
  };
  const uniqueTitles = (candidates: string[]): string[] => {
    const titles: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      let title = boundedTitle([candidate]);
      let suffix = 1;
      while (seen.has(title) && [...title].length < 40) {
        suffix += 1;
        title = boundedTitle([`${candidate}${suffix}`]);
      }
      if (seen.has(title)) continue;
      seen.add(title);
      titles.push(title);
      if (titles.length === 5) break;
    }
    return titles;
  };
  const fixedTag = (label: string, fact: string): string => {
    let tag = `${label}${clean(fact)}`;
    const padding = `${label}事实记录内容`;
    while (tag.length < 12) tag += padding;
    return tag.slice(0, 12);
  };

  const subject = clean(brief.core_subject);
  const event = clean(brief.core_event);
  const hook = clean(brief.hook);
  const turningPoint = clean(brief.turning_point) || event;
  const outcome = clean(brief.outcome) || event;
  const firstTimeline = brief.timeline[0] || {
    summary_zh: event,
    evidence_ids: brief.core_event_evidence_ids,
  };
  const lastTimeline = brief.timeline.at(-1) || firstTimeline;
  const conservativeTitleEvidence = uniqueIds(brief.core_subject_evidence_ids, brief.core_event_evidence_ids);
  const titleCandidates = uniqueTitles([
    `${subject}：${event}`,
    event,
    subject,
    `${event}：${subject}`,
    `${subject}${event}`,
  ]);
  while (titleCandidates.length < 5) {
    titleCandidates.push(boundedTitle([`${subject}${event}${titleCandidates.length}`]));
  }
  const titleSpecs = titleCandidates.map(title => ({
    title,
    evidence_ids: [...conservativeTitleEvidence],
  }));
  const titleReasons = titleSpecs.map((spec, titleIndex) => ({
    title_index: titleIndex,
    evidence_ids: spec.evidence_ids,
    reason: "保守回退仅使用事实卡中有证据链接的确认事实",
  }));

  const tagSpecs = [
    { tag: fixedTag("主体", subject), evidence_ids: [...brief.core_subject_evidence_ids] },
    { tag: fixedTag("事件", event), evidence_ids: [...brief.core_event_evidence_ids] },
    { tag: fixedTag("看点", hook), evidence_ids: [...brief.hook_evidence_ids] },
    { tag: fixedTag("转折", turningPoint), evidence_ids: clean(brief.turning_point) ? [...brief.turning_point_evidence_ids] : [...brief.core_event_evidence_ids] },
    { tag: fixedTag("结果", outcome), evidence_ids: clean(brief.outcome) ? [...brief.outcome_evidence_ids] : [...brief.core_event_evidence_ids] },
    { tag: fixedTag("时间", firstTimeline.summary_zh), evidence_ids: [...firstTimeline.evidence_ids] },
    { tag: fixedTag("画面", lastTimeline.summary_zh), evidence_ids: [...lastTimeline.evidence_ids] },
    { tag: fixedTag("场景", `${subject}${hook}`), evidence_ids: uniqueIds(brief.core_subject_evidence_ids, brief.hook_evidence_ids) },
    { tag: fixedTag("过程", `${subject}${event}`), evidence_ids: uniqueIds(brief.core_subject_evidence_ids, brief.core_event_evidence_ids) },
    { tag: fixedTag("证据", `${event}${hook}`), evidence_ids: uniqueIds(brief.core_event_evidence_ids, brief.hook_evidence_ids) },
  ];
  const tags = tagSpecs.map(spec => spec.tag);
  const tagEvidence = tagSpecs.map(spec => ({
    tag: spec.tag,
    evidence_ids: spec.evidence_ids,
  }));

  const descriptionParts = [
    `核心主体：${subject}`,
    `核心事件：${event}`,
    clean(brief.turning_point) ? `关键转折：${turningPoint}` : "",
    clean(brief.outcome) ? `确认结果：${outcome}` : "",
    `视频看点：${hook}`,
  ].filter(Boolean);
  let description = `${descriptionParts.join("。")}。`;
  const conservativeNotice = "以上仅记录事实卡中已有证据支持的内容，不推断无法确认的人物身份、对白、因果、结果或字幕状态。";
  while (description.length < 60) description += conservativeNotice;
  description = description.slice(0, 1000);

  return {
    title_candidates: titleCandidates,
    recommended_title_index: 0,
    title_reasons: titleReasons,
    tags,
    tag_evidence: tagEvidence,
    description,
    tid: Number.isInteger(draft.tid) && draft.tid >= 1 && draft.tid <= 9999 ? draft.tid : 21,
  };
}
