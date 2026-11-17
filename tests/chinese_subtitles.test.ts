import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyTranslatedCues,
  buildChineseSubtitleTranslatePrompt,
  buildSubtitlesFilter,
  chunkByCount,
  cuesToSrt,
  formatSrtTimestamp,
  frameSizeFromProbe,
  indexCues,
  mergeFragmentCues,
  materializeChineseSubtitles,
  paginateChineseSubtitle,
  subtitleLayoutForFrame,
  textLooksChinese,
  transcriptNeedsTranslation,
  userExplicitlyRequestedChineseSubtitles,
  userRequestedChineseSubtitles,
  wrapChineseSubtitle,
} from "../chinese_subtitles";

describe("chinese subtitle intent", () => {
  test("burns chinese subtitles by default and only skips an explicit refusal", () => {
    expect(userRequestedChineseSubtitles("添加中文字幕")).toBe(true);
    expect(userRequestedChineseSubtitles("加上字幕并保存到桌面")).toBe(true);
    expect(userRequestedChineseSubtitles("烧录硬字幕")).toBe(true);
    expect(userRequestedChineseSubtitles("中英双字")).toBe(true);
    expect(userRequestedChineseSubtitles("")).toBe(true);
    expect(userRequestedChineseSubtitles("突出结尾的马")).toBe(true);
    expect(userRequestedChineseSubtitles("不要字幕，只写标题")).toBe(false);
    expect(userRequestedChineseSubtitles("不加中文字幕")).toBe(false);
    expect(userRequestedChineseSubtitles("添加中文字幕", false)).toBe(false);
    expect(userRequestedChineseSubtitles("", false)).toBe(false);
    expect(userExplicitlyRequestedChineseSubtitles("")).toBe(false);
    expect(userExplicitlyRequestedChineseSubtitles("突出结尾的马")).toBe(false);
    expect(userExplicitlyRequestedChineseSubtitles("添加中文字幕")).toBe(true);
  });
});

describe("chinese subtitle copy", () => {
  test("formats srt timestamps and wraps long chinese lines", () => {
    expect(formatSrtTimestamp(0)).toBe("00:00:00,000");
    expect(formatSrtTimestamp(72.5)).toBe("00:01:12,500");
    expect(wrapChineseSubtitle("今天我该做什么")).toBe("今天我该做什么");
    expect(wrapChineseSubtitle("古人整天在做的事，为什么你却做不到这些？")).toBe("古人整天在做的事，\n为什么你却做不到这些？");
  });

  test("writes srt from translated cues", () => {
    const srt = cuesToSrt([
      { start: 0, end: 1.2, text: "Hello", text_zh: "你好" },
      { start: 1.2, end: 1.2, text: "World", text_zh: "世界" },
    ]);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,200\n你好");
    expect(srt).toContain("2\n00:00:01,200 --> 00:00:01,600\n世界");
  });

  test("translates only non-chinese transcripts and rejects missing cue indexes", () => {
    expect(textLooksChinese("今天我该做什么")).toBe(true);
    expect(textLooksChinese("What should I do today")).toBe(false);
    expect(transcriptNeedsTranslation("en", [{ start: 0, end: 1, text: "Hello" }])).toBe(true);
    expect(transcriptNeedsTranslation("zh", [{ start: 0, end: 1, text: "你好" }])).toBe(false);
    expect(transcriptNeedsTranslation("en", [{ start: 0, end: 1, text: "古人醒来问自己" }])).toBe(false);
    const batch = indexCues([{ start: 0, end: 1, text: "Hello" }, { start: 1, end: 2, text: "World" }]);
    expect(applyTranslatedCues(batch, { cues: [{ index: 1, text_zh: "你好" }, { index: 2, text_zh: "世界" }] }))
      .toEqual([{ index: 1, text_zh: "你好" }, { index: 2, text_zh: "世界" }]);
    expect(() => applyTranslatedCues(batch, { cues: [{ index: 1, text_zh: "你好" }] })).toThrow("缺少条目");
  });

  test("merges chopped asr fragments and keeps a pause as a new card", () => {
    const merged = mergeFragmentCues(indexCues([
      { start: 31.04, end: 35.52, text: "That's what everyone" },
      { start: 35.52, end: 39.9, text: "believed. For centuries, that was the official story." },
    ]));
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toContain("That's what everyone believed.");
    expect(mergeFragmentCues(indexCues([
      { start: 0, end: 1, text: "Hello." },
      { start: 3, end: 4, text: "World." },
    ]))).toHaveLength(2);
  });

  test("keeps translation prompt bound to the whole narration", () => {
    const batch = [{ index: 2, start: 4, end: 9, text: "your day was already decided." }];
    const prompt = buildChineseSubtitleTranslatePrompt({
      batch,
      script: [
        { index: 1, start: 0, end: 4, text: "This morning, a machine screamed at you until you woke up." },
        ...batch,
      ],
      previousZh: [{ index: 1, text_zh: "今早闹钟把你叫醒，你按掉了它。" }],
      upcoming: [],
      context: "朱/'霍安西人",
    });
    expect(prompt).toContain("不是逐条英译中");
    expect(prompt).toContain("全文英文口播");
    expect(prompt).toContain("今早闹钟把你叫醒");
    expect(prompt).toContain("your day was already decided.");
    expect(prompt).toContain("朱/'霍安西人");
    expect(chunkByCount([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("paginates long chinese without dropping characters", () => {
    const source = "远古生活残酷、短暂、绝望。每一秒都是求生。那就是所有人曾经相信的官方说法。";
    const pages = paginateChineseSubtitle(source);
    expect(pages.join("").replaceAll("\n", "")).toBe(source.replaceAll(" ", ""));
    expect(pages.length).toBeGreaterThan(1);
  });

  test("folds a leftover short tail back into the previous screen", () => {
    const pages = paginateChineseSubtitle("他们会觉得奇怪你拿这一切换了一声尖叫的闹钟和一句许诺");
    expect(pages.at(-1)?.replaceAll("\n", "")).not.toBe("句许诺");
    expect(pages.join("").replaceAll("\n", "")).toContain("一句许诺");
  });

  test("escapes subtitle filter paths", () => {
    expect(buildSubtitlesFilter("zh.srt", "Heiti SC", "/System/Library/Fonts"))
      .toContain("subtitles=filename='zh.srt'");
    expect(buildSubtitlesFilter("zh.srt", "Heiti SC", "/System/Library/Fonts"))
      .toContain("FontName=Heiti SC");
  });

  test("places landscape subtitles at the bottom and portrait subtitles above the vertical chrome", () => {
    const landscape = subtitleLayoutForFrame(1920, 1080);
    const portrait = subtitleLayoutForFrame(1080, 1920);
    expect(landscape.orientation).toBe("landscape");
    expect(landscape.fontSize).toBe(20);
    expect(landscape.marginV).toBe(40);
    expect(landscape.maxPerLine).toBe(16);
    expect(portrait.orientation).toBe("portrait");
    expect(portrait.fontSize).toBeLessThan(landscape.fontSize);
    expect(portrait.marginV).toBeGreaterThan(landscape.marginV);
    expect(portrait.marginR).toBeGreaterThan(portrait.marginL);
    expect(portrait.maxPerLine).toBe(11);
    expect(subtitleLayoutForFrame(1080, 1080).orientation).toBe("landscape");

    const landscapeFilter = buildSubtitlesFilter("zh.srt", "Heiti SC", "/System/Library/Fonts", landscape);
    const portraitFilter = buildSubtitlesFilter("zh.srt", "Heiti SC", "/System/Library/Fonts", portrait);
    expect(landscapeFilter).toContain("FontSize=20");
    expect(landscapeFilter).toContain("MarginV=40");
    expect(landscapeFilter).not.toContain("MarginR=");
    expect(portraitFilter).toContain(`FontSize=${portrait.fontSize}`);
    expect(portraitFilter).toContain(`MarginV=${portrait.marginV}`);
    expect(portraitFilter).toContain(`MarginR=${portrait.marginR}`);
  });

  test("wraps portrait subtitles onto shorter lines and treats rotated phone video as portrait", () => {
    const portrait = subtitleLayoutForFrame(1080, 1920);
    const srt = cuesToSrt([
      { start: 0, end: 2, text: "hello", text_zh: "古人整天在做的事，为什么你却做不到这些？" },
    ], portrait);
    const textLines = srt.split("\n").filter(line => line && !/^\d+$/.test(line) && !line.includes("-->"));
    expect(textLines.length).toBeGreaterThan(1);
    expect(textLines.every(line => [...line].length <= portrait.maxPerLine)).toBe(true);
    expect(frameSizeFromProbe({
      streams: [{ codec_type: "video", width: 1920, height: 1080, tags: { rotate: "90" } }],
    })).toEqual({ width: 1080, height: 1920 });
    expect(subtitleLayoutForFrame(1080, 1920).orientation).toBe("portrait");
  });

  test("burns chinese srt onto a generated clip when libass ffmpeg is available", async () => {
    const ffmpeg = "/opt/homebrew/Caskroom/miniforge/base/bin/ffmpeg";
    if (!existsSync(ffmpeg)) return;
    const directory = mkdtempSync(join(tmpdir(), "bili-subs-"));
    try {
      const source = join(directory, "video.mp4");
      const generated = Bun.spawnSync([
        ffmpeg, "-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=1",
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
      ], { stdout: "ignore", stderr: "pipe" });
      expect(generated.exitCode).toBe(0);
      writeFileSync(join(directory, "zh.srt"), "1\n00:00:00,000 --> 00:00:01,000\n你好\n");
      const burned = await materializeChineseSubtitles({
        videoFile: source,
        artifactDir: directory,
        language: "zh",
        cues: [{ start: 0, end: 1, text: "你好" }],
        ffmpegBin: ffmpeg,
      });
      expect(existsSync(burned.subtitleFile)).toBe(true);
      expect(existsSync(burned.videoFile)).toBe(true);
      expect(burned.translated).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
