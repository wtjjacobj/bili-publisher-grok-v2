# Evidence-First Bilibili Metadata Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the B站投稿助手 understand the whole video from time-distributed frames and local speech transcription, then generate and independently review accurate, specific Chinese titles, descriptions, and tags.

**Architecture:** Preparation produces deterministic visual and transcript evidence. A structured analysis call turns that evidence into a grounded fact card; a writer produces metadata from only that fact card; a separate reviewer vetoes unsupported or generic copy and drives one rewrite before conservative fallback. The browser defaults to the reviewed recommended title and clearly distinguishes speech detection from actual subtitles.

**Tech Stack:** Bun/TypeScript, Python 3.13, ffmpeg/ffprobe, faster-whisper `large-v3-turbo`, Codex structured output JSON schemas, Bun test, Python `unittest`.

## Global Constraints

- Accuracy outranks click appeal; no title or tag may invent a person, work, location, quote, result, subtitle, or causal claim.
- Analyze ten frames at 5%, 15%, 25%, 35%, 45%, 55%, 65%, 75%, 85%, and 95% of duration.
- Speech transcription is local and for understanding only; this feature does not create or burn subtitles.
- Use Chinese conventional names for people; otherwise use a defensible Chinese transliteration, and use a neutral role when identity is uncertain.
- Preserve English company, product, event, and industry abbreviations such as `SpaceX`, `NBA`, `FIFA`, and `OpenAI`.
- Keep old `result.json` files loadable and publishable.
- Keep screenshot, activity selection, and draft publishing behavior working.
- The project is not a Git repository. Do not initialize Git; use passing tests as task checkpoints instead of commits.

---

## File Structure

- Create `content_evidence.py`: pure timeline helpers, audio-state handling, local Whisper transcription, and analysis-frame capture.
- Modify `prepare_video.py`: orchestrate evidence generation and enrich `prepare_result.json` without changing existing cover paths.
- Create `content_brief_schema.json`: structured fact-card contract.
- Modify `metadata_schema.json`: add recommended-title and evidence fields to the writer contract.
- Create `metadata_review_schema.json`: independent-review contract.
- Create `metadata_quality.ts`: shared TypeScript contracts, deterministic grounding checks, review-state handling, and conservative fallback.
- Create `metadata_pipeline.ts`: prompt builders and pure result assembly; it must not start the server.
- Modify `server.ts`: run analysis → writing → review → optional rewrite/review and persist stage artifacts.
- Create `public/ui_helpers.js`: browser-safe pure recommendation and speech-label helpers.
- Modify `public/index.html`: recommended-title selection, review warning, and accurate speech-status copy.
- Create `tests/test_content_evidence.py`: deterministic Python evidence tests.
- Create `tests/metadata_quality.test.ts`: grounding and fallback behavior tests.
- Create `tests/metadata_pipeline.test.ts`: result assembly and backward-compatibility tests.
- Create `tests/ui_helpers.test.ts`: browser helper behavior tests without a DOM dependency.
- Modify `tests/server_utils.test.ts`: strengthen the formerly format-only valid metadata fixture.
- Modify `package.json`: include all new tests in the standard test command.

---

### Task 1: Deterministic Visual and Speech Evidence

**Files:**
- Create: `content_evidence.py`
- Modify: `prepare_video.py`
- Create: `tests/test_content_evidence.py`
- Modify: `package.json`

**Interfaces:**
- Produces: `analysis_frame_times(duration: float, count: int = 10) -> list[float]`
- Produces: `capture_analysis_frames(video_path: Path, job_dir: Path, duration: float) -> list[dict]`
- Produces: `has_audio_stream(probe_data: dict) -> bool`
- Produces: `no_audio_transcript() -> dict`
- Produces: `transcribe_video(video_path: Path, audio_present: bool) -> dict`
- Produces: `prepare_result.analysis_frames`, `prepare_result.transcript_file`, `prepare_result.has_speech`

- [ ] **Step 1: Write failing timeline and audio-state tests**

```python
from content_evidence import analysis_frame_times, has_audio_stream, no_audio_transcript


def test_analysis_frames_cover_opening_and_ending():
    assert analysis_frame_times(100.0) == [5.0, 15.0, 25.0, 35.0, 45.0, 55.0, 65.0, 75.0, 85.0, 95.0]


def test_short_video_still_has_ten_ordered_times():
    times = analysis_frame_times(0.5)
    assert len(times) == 10
    assert times == sorted(times)
    assert times[0] == 0.025
    assert times[-1] == 0.475


def test_audio_detection_and_no_audio_result():
    probe = {"streams": [{"codec_type": "video"}, {"codec_type": "audio"}]}
    assert has_audio_stream(probe) is True
    assert no_audio_transcript() == {
        "status": "no_audio",
        "has_speech": False,
        "language": "",
        "segments": [],
        "error": "",
    }
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `/opt/homebrew/Caskroom/miniforge/base/bin/python3 -m unittest tests/test_content_evidence.py`

Expected: FAIL because `content_evidence` does not exist.

- [ ] **Step 3: Implement evidence helpers and lazy local transcription**

Implement `analysis_frame_times` using exact `(index + 0.5) / count` ratios. Implement `capture_analysis_frames` with one ffmpeg call per timestamp and return records shaped as:

```python
{"id": "frame-01", "time": 1.733, "path": "/absolute/job/analysis_frames/frame01.jpg"}
```

Implement `transcribe_video` with lazy import and local cached model loading:

```python
from faster_whisper import WhisperModel

model = WhisperModel(
    os.environ.get("BILI_TRANSCRIBE_MODEL", "large-v3-turbo"),
    device="cpu",
    compute_type="int8",
    local_files_only=True,
)
segments, info = model.transcribe(str(video_path), vad_filter=True, beam_size=5)
```

Return `status: "ready"` only when at least one non-empty segment exists. Catch transcription exceptions and return `status: "unavailable"`, `has_speech: None`, empty segments, and a bounded error message; do not fail video preparation.

- [ ] **Step 4: Wire evidence into preparation**

Change `probe_video` consumption to retain probe JSON. After the existing three cover images:

```python
analysis_frames = capture_analysis_frames(video_path, job_dir, duration)
audio_present = has_audio_stream(probe_data)
transcript = transcribe_video(video_path, audio_present)
write_json(job_dir / "visual_timeline.json", {"frames": analysis_frames})
write_json(job_dir / "transcript.json", transcript)
```

Add `analysis_frames`, `transcript_file`, `transcript_status`, and `has_speech` to `prepare_result.json`. Do not replace `screenshots`.

- [ ] **Step 5: Run Python tests and compile preparation code**

Run:

```bash
/opt/homebrew/Caskroom/miniforge/base/bin/python3 -m unittest tests/test_content_evidence.py tests/test_prepare_video.py
/opt/homebrew/Caskroom/miniforge/base/bin/python3 -m py_compile content_evidence.py prepare_video.py
```

Expected: all tests PASS and compilation exits 0.

- [ ] **Step 6: Record the non-Git checkpoint**

Run: `git rev-parse --is-inside-work-tree 2>&1 || true`

Expected: `fatal: not a git repository`; do not initialize or commit.

---

### Task 2: Fact Card, Draft, and Review Contracts

**Files:**
- Create: `content_brief_schema.json`
- Modify: `metadata_schema.json`
- Create: `metadata_review_schema.json`
- Create: `metadata_quality.ts`
- Create: `tests/metadata_quality.test.ts`

**Interfaces:**
- Produces: `ContentBrief`, `MetadataDraft`, and `MetadataReview` TypeScript types
- Produces: `assessMetadataAgainstBrief(draft: MetadataDraft, brief: ContentBrief): string[]`
- Produces: `reviewIsApproved(review: MetadataReview): boolean`
- Produces: `buildConservativeDraft(brief: ContentBrief, draft: MetadataDraft): MetadataDraft`
- Consumes later: schemas are passed directly to Codex `--output-schema`

- [ ] **Step 1: Write failing deterministic grounding tests**

Define literal factories in the test file so every expectation is derived independently from production code:

```ts
const evidence = [
  { id: "source-1", kind: "source", summary_zh: "原帖说明蒙古派对中也有人骑马" },
  { id: "frame-10", kind: "frame", summary_zh: "结尾画面出现骑马者" },
];

function makeMongoliaBrief() {
  return {
    video_type: "现场短视频",
    core_subject: "蒙古国电音派对",
    core_event: "骑马者进入派对人群",
    timeline: [{ time: 22, summary_zh: "骑马者出现在舞池", evidence_ids: ["frame-10"] }],
    turning_point: "镜头转向人群后出现马匹",
    outcome: "骑马者穿过派对现场",
    hook: "马进入电音派对",
    evidence,
    entities: [],
    source_account: "Massimo",
    verified_dialogue: [],
    uncertainties: [],
    forbidden_claims: [],
  };
}

function makeDraft(overrides = {}) {
  return {
    title_candidates: ["蒙古派对竟有人骑马", "马走进蒙古电音派对", "DJ台下突然出现马匹", "蒙古人的派对少不了马", "电音现场骑马穿过人群"],
    recommended_title_index: 0,
    title_reasons: Array.from({ length: 5 }, (_, index) => ({ title_index: index, evidence_ids: ["source-1", "frame-10"], reason: "覆盖核心反差" })),
    tags: ["蒙古国", "蒙古马", "骑马", "电音派对", "DJ现场", "派对人群", "夜间活动", "现场记录", "反差场面", "短视频"],
    tag_evidence: ["蒙古国", "蒙古马", "骑马", "电音派对", "DJ现场", "派对人群", "夜间活动", "现场记录", "反差场面", "短视频"].map(tag => ({ tag, evidence_ids: ["source-1", "frame-10"] })),
    description: "蒙古国一场电音派对进行到后段，镜头从女DJ转向台下人群，骑马者随即穿过红色灯光下的现场。马匹出现在舞池旁，正是这段短视频最有辨识度的反差。",
    tid: 21,
    ...overrides,
  };
}
```

```ts
test("rejects an English person name when a confirmed Chinese name exists", () => {
  const personBrief = {
    ...makeMongoliaBrief(),
    entities: [{
      original_name: "Rhaenyra Targaryen",
      zh_name: "雷妮拉·坦格利安",
      type: "person",
      confidence: 1,
      evidence_ids: ["source-1"],
    }],
  };
  const issues = assessMetadataAgainstBrief(
    makeDraft({ title_candidates: ["Rhaenyra Targaryen擂台对决", "雷妮拉走进格斗笼", "龙之家族角色擂台对决", "雷妮拉与阿莉森特开打", "剧中宿敌被放进八角笼"] }),
    personBrief,
  );
  expect(issues).toContain("人物名未使用已确认的中文名称：雷妮拉·坦格利安");
});

test("rejects tags without valid evidence and near-duplicate tags", () => {
  const draft = makeDraft({
    tags: ["求婚", "现场求婚", "求婚成功", "情侣", "庆祝", "户外舞台", "观众", "舞蹈", "情感", "短视频"],
    tag_evidence: [],
  });
  expect(assessMetadataAgainstBrief(draft, makeMongoliaBrief()).length).toBeGreaterThan(0);
});

test("conservative fallback names the confirmed subject and event", () => {
  const result = buildConservativeDraft(makeMongoliaBrief(), makeDraft({
    title_candidates: ["蒙古DJ现场", "派对气氛热烈", "红光下的舞池", "电音派对记录", "DJ带动全场"],
  }));
  expect(result.title_candidates[result.recommended_title_index]).toContain("马");
});
```

- [ ] **Step 2: Run the new Bun test and verify RED**

Run: `bun test tests/metadata_quality.test.ts`

Expected: FAIL because `metadata_quality.ts` does not exist.

- [ ] **Step 3: Create strict JSON schemas**

`content_brief_schema.json` must require:

```json
[
  "video_type", "core_subject", "core_event", "timeline", "turning_point",
  "outcome", "hook", "evidence", "entities", "source_account",
  "verified_dialogue", "uncertainties", "forbidden_claims"
]
```

Every entity must contain `original_name`, `zh_name`, `type`, `confidence`, and non-empty `evidence_ids`. Every evidence item must have a unique `id`, `kind`, and `summary_zh`.

Update `metadata_schema.json` to require `recommended_title_index`, five `title_reasons`, and ten `tag_evidence` items in addition to the existing fields. Each reason/evidence item carries at least one `evidence_id`.

`metadata_review_schema.json` must require `approved`, five integer scores from 1 to 5, `issues`, and `rewrite_instructions`.

- [ ] **Step 4: Implement deterministic metadata checks**

`assessMetadataAgainstBrief` must:

- reject invalid recommendation indices;
- ensure each reason/tag references an evidence ID present in the brief;
- reject an original Latin-script person name when that entity has a non-empty Chinese name;
- reject exact and containment-based near-duplicate tags such as `求婚` / `现场求婚`;
- reject unsupported subtitle claims when `subtitle_file` is absent at result assembly time;
- reject generic-only titles matching `发生了什么|接下来会怎样|现场画面|为何这样` when they do not include the brief subject, event, or hook.

`reviewIsApproved` requires `approved === true`, grounding score 5, relevance at least 4, specificity at least 4, Chinese-naturalness at least 4, and no issues.

- [ ] **Step 5: Run quality tests**

Run: `bun test tests/metadata_quality.test.ts`

Expected: all tests PASS.

- [ ] **Step 6: Record the non-Git checkpoint**

Run: `git rev-parse --is-inside-work-tree 2>&1 || true`

Expected: repository check fails; no commit is attempted.

---

### Task 3: Structured Analysis, Writing, and Independent Review Pipeline

**Files:**
- Create: `metadata_pipeline.ts`
- Modify: `server.ts`
- Create: `tests/metadata_pipeline.test.ts`
- Modify: `tests/server_utils.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `prepare_result.analysis_frames`, `transcript_file`, `has_speech`
- Consumes: all three JSON schema paths
- Produces: `buildContentBriefPrompt(prepared, transcript, userDescription): string`
- Produces: `buildMetadataDraftPrompt(brief, userDescription, rewriteInstructions?): string`
- Produces: `buildMetadataReviewPrompt(brief, draft): string`
- Produces: `assembleResult(draft, prepared, copyStatus): object`
- Produces: `resolveRecommendedTitleIndex(result): number`
- Produces artifacts: `content_brief.json`, `metadata_review.json`, enriched `result.json`

- [ ] **Step 1: Write failing result-assembly and backward-compatibility tests**

```ts
test("assembles an approved result without claiming subtitles", () => {
  const draft = {
    title_candidates: ["标题甲", "标题乙", "准确推荐标题", "标题丁", "标题戊"],
    recommended_title_index: 2,
    title_reasons: [], tags: [], tag_evidence: [], description: "具体简介", tid: 21,
  };
  const preparedWithSpeech = {
    video_file: "/workspace/job/video.mp4",
    screenshots: ["a.jpg", "b.jpg", "c.jpg"],
    has_speech: true,
  };
  const result = assembleResult(draft, preparedWithSpeech, "approved");
  expect(result.recommended_title_index).toBe(2);
  expect(result.copy_status).toBe("approved");
  expect(result.has_speech).toBe(true);
  expect(result.subtitle_file).toBe("");
  expect(result.segments).toEqual([]);
});

test("normalizes old results to title index zero", () => {
  expect(resolveRecommendedTitleIndex({ title_candidates: ["旧标题"] })).toBe(0);
});
```

- [ ] **Step 2: Run the new pipeline test and verify RED**

Run: `bun test tests/metadata_pipeline.test.ts`

Expected: FAIL because `metadata_pipeline.ts` does not exist.

- [ ] **Step 3: Implement pure prompt and assembly boundaries**

Content-analysis prompt must explicitly instruct the model to distinguish source account from work/person, translate transcript evidence into Chinese, record uncertainties, and never write publication copy.

Draft prompt must state that it can only use fact-card evidence IDs and must apply the title, tag, description, and Chinese-person-name rules from the approved design.

Review prompt must make unsupported claims an automatic rejection and require concrete rewrite instructions.

`assembleResult` must preserve `video_file`, `screenshots`, `activities: []`, `subtitle_file: ""`, `segments: []`, and carry `has_speech`, `recommended_title_index`, and `copy_status`.

- [ ] **Step 4: Replace the one-shot loop in `runSimplifiedProcessing`**

Implement this sequence with existing `runCodexProcess`:

1. Analyze with primary model at medium reasoning, ten analysis images, `content_brief_schema.json`.
2. Validate and persist `content_brief.json`.
3. Write with primary model at medium reasoning, no images, `metadata_schema.json`.
4. Run deterministic checks from `metadata_quality.ts`.
5. Review with fallback model at medium reasoning, `metadata_review_schema.json`.
6. If deterministic checks or review fail, write once more with explicit issues and re-review once.
7. If second review fails, call `buildConservativeDraft`, set `copy_status: "needs_review"`, and preserve review issues.
8. Persist final `metadata_review.json` and `result.json` atomically.

Use the fallback model for analysis/writing only when the primary call itself fails. If the fallback wrote the draft, use the primary model as reviewer to preserve reviewer independence.

- [ ] **Step 5: Strengthen existing structural tests**

Replace `标题一` / `标签1` fixtures in `tests/server_utils.test.ts` with a specific literal event fixture. Add assertions that `recommended_title_index` is validated and unsupported subtitle copy cannot pass assembled-result assessment.

- [ ] **Step 6: Run all server-side tests and build**

Run:

```bash
bun test tests/server_utils.test.ts tests/metadata_quality.test.ts tests/metadata_pipeline.test.ts
bun build server.ts --target bun --outfile /tmp/bili-publisher-server-check.js
```

Expected: all Bun tests PASS and build exits 0.

- [ ] **Step 7: Record the non-Git checkpoint**

Run the repository check and do not commit because the project has no `.git` directory.

---

### Task 4: Recommended Title and Honest Status UI

**Files:**
- Create: `public/ui_helpers.js`
- Modify: `public/index.html`
- Modify: `server.ts`
- Create: `tests/ui_helpers.test.ts`

**Interfaces:**
- Consumes: `result.recommended_title_index`, `result.copy_status`, `result.has_speech`
- Produces: default selected title, “推荐” badge, manual-review warning, accurate speech copy

- [ ] **Step 1: Add failing pure browser-helper tests**

Create a test that imports the classic-script helper and verifies recommendation bounds and honest speech labels:

```ts
await import("../public/ui_helpers.js");
const helpers = (globalThis as any).BiliUiHelpers;

expect(helpers.resolveRecommendedTitleIndex({ recommended_title_index: 2, title_candidates: ["a", "b", "c"] })).toBe(2);
expect(helpers.resolveRecommendedTitleIndex({ recommended_title_index: 9, title_candidates: ["a"] })).toBe(0);
expect(helpers.speechStatusCopy(true)).toBe("检测到语音 · 仅用于理解");
expect(helpers.speechStatusCopy(false)).toBe("无明显语音 · 未生成字幕");
expect(helpers.speechStatusCopy(null)).toBe("原视频 · 未处理字幕");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test tests/ui_helpers.test.ts`

Expected: FAIL because `public/ui_helpers.js` does not exist.

- [ ] **Step 3: Implement and serve the browser helper**

Expose `globalThis.BiliUiHelpers` from a classic script with `resolveRecommendedTitleIndex` and `speechStatusCopy`. Add an authenticated `GET /ui_helpers.js` route with JavaScript content type and `Cache-Control: no-store`, and load it before the main inline script.

- [ ] **Step 4: Update title rendering**

In `showResult`, compute:

```js
const recommendedIndex = BiliUiHelpers.resolveRecommendedTitleIndex(data);
```

Append a compact `推荐` badge only to that candidate, set `selectedTitle` to its text, and select that element rather than `container.children[0]`.

- [ ] **Step 5: Add review and speech-state copy**

- `copy_status === "needs_review"`: show an orange warning above title candidates saying `文案证据不足，请人工检查后再投稿`.
- `has_speech === true`: show `检测到语音 · 仅用于理解`.
- `has_speech === false`: show `无明显语音 · 未生成字幕`.
- missing legacy value: show `原视频 · 未处理字幕`.

Remove every implication that detected speech means subtitles were added.

- [ ] **Step 6: Run browser-helper tests, validate scripts, and build**

Run `bun test tests/ui_helpers.test.ts`, a Bun syntax check over each inline `<script>` block, then run `bun build server.ts --target bun --outfile /tmp/bili-publisher-server-check.js`.

Expected: `frontend_script_syntax=ok` and build exits 0.

- [ ] **Step 7: Record the non-Git checkpoint**

Do not initialize Git; the passing UI syntax/build checks are the checkpoint.

---

### Task 5: Regression Fixtures, Full Verification, and Service Restart

**Files:**
- Create: `tests/fixtures/content_briefs/mongolia-rave.json`
- Create: `tests/fixtures/content_briefs/source-account-not-work.json`
- Create: `tests/fixtures/content_briefs/star-wars-wedding.json`
- Create: `tests/fixtures/content_briefs/no-subtitle.json`
- Modify: `tests/metadata_quality.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: final evidence, quality, pipeline, and UI behavior
- Produces: repeatable regressions for the concrete failures reported by the user

- [ ] **Step 1: Write failing fixture-based regression tests**

Add literal bad drafts and assert:

- Mongolia draft without `马` in every title/description combination is rejected when the fact card hook is `马进入电音派对`.
- A draft treating `The Werewolf` source account as a film title is rejected.
- A Star Wars tag with no evidence ID is rejected.
- `中文字幕` is rejected when `subtitle_file` is empty.
- `求婚`, `现场求婚`, and `求婚成功` cannot coexist as distinct tags.

- [ ] **Step 2: Run regressions and verify RED for any missing gate**

Run: `bun test tests/metadata_quality.test.ts`

Expected: any unimplemented gate FAILS with its named fixture; existing gates may already pass.

- [ ] **Step 3: Implement only the missing deterministic gates**

Keep semantic judgments in the independent reviewer. Add deterministic logic only for evidence-ID validity, confirmed core-hook omission, source-account misuse, subtitle-state contradiction, person-name localization, and near-duplicate tags.

- [ ] **Step 4: Run the complete project check**

Run: `bun run check`

Expected: all Bun and Python tests PASS, Python output reports `OK`, and Bun server bundle succeeds.

- [ ] **Step 5: Run a local end-to-end regression on existing videos**

Use local video files from `workspace/ca4bfdf1`, `workspace/922e1b67`, and `workspace/e74158d1` without publishing. Copy only the required video and source metadata into exact temporary job IDs `regression-mongolia-20260814`, `regression-account-20260814`, and `regression-starwars-20260814`. Verify generated `content_brief.json` and final copy meet the corresponding fixture acceptance criteria. Do not alter existing `publish_status.json`; remove only these three exact temporary directories after recording results.

- [ ] **Step 6: Restart the exact service on port 3456**

Resolve the listener PID and working directory first. Stop only the Bun process whose cwd is `/Users/wangtangjie/Projects/bili-publisher`, start `bun server.ts`, and verify:

```text
GET / -> 200
GET /api/health -> authenticated JSON status ok
GET /api/activities?tid=130 -> success with topic_id and mission_id
```

- [ ] **Step 7: Browser smoke test**

Load an existing approved task and confirm:

- recommended title is selected and badged;
- legacy task falls back to first title;
- speech badge never claims subtitles merely from speech detection;
- activity selection and rescreenshot buttons still work;
- a needs-review result shows the manual warning.

- [ ] **Step 8: Final verification checkpoint**

Freshly rerun `bun run check`, service health, frontend syntax check, and the fixture regression suite. Report exact pass counts and any behavior intentionally deferred by the non-goals.
