import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CHANNELS_CHECKBOX_ID,
  CHANNELS_CHECKBOX_LABEL,
  LOCAL_ARCHIVE_FOLDER,
  channelsPostRequested,
  localArchiveDir,
  publishExtras,
  saveSubmittedVideos,
} from "../post_options";
import { channelsDraftCommand } from "../channels_bridge";

const html = readFileSync(join(import.meta.dir, "../public/index.html"), "utf-8");
const server = readFileSync(join(import.meta.dir, "../server.ts"), "utf-8");

describe("视频号 checkbox", () => {
  test("defaults off and is not pre-checked", () => {
    expect(channelsPostRequested(undefined)).toBe(false);
    expect(channelsPostRequested(false)).toBe(false);
    expect(channelsPostRequested("true")).toBe(false);
    expect(channelsPostRequested(1)).toBe(false);
    expect(channelsPostRequested(true)).toBe(true);
    expect(publishExtras(undefined)).toEqual({ saveLocal: true, postChannels: false });
    expect(publishExtras(false)).toEqual({ saveLocal: true, postChannels: false });
    expect(publishExtras(true)).toEqual({ saveLocal: true, postChannels: true });

    const tag = html.match(/<input[^>]*id="channelsPostCheck"[^>]*>/)?.[0] || "";
    expect(tag).toContain(`id="${CHANNELS_CHECKBOX_ID}"`);
    expect(tag).toContain('type="checkbox"');
    expect(tag).not.toMatch(/\schecked(?:\s|=|>|$)/);
    expect(html).toContain(CHANNELS_CHECKBOX_LABEL);
    expect(html.indexOf('id="channelsPostCheck"')).toBeLessThan(html.indexOf('id="resultSection"'));
    expect(html).toContain("postToChannels: document.getElementById('channelsPostCheck').checked === true");
  });

  test("server saves locally on every submit and only starts 视频号 when requested", () => {
    expect(server).toContain("saveSubmittedVideos(");
    expect(server).toContain("channelsPostRequested(data.postToChannels)");
    expect(server).toContain("startChannelsDraft(");
    const saveAt = server.indexOf("saveSubmittedVideos(");
    const uploadAt = server.indexOf('args.push(\n    "--title"');
    const gateAt = server.indexOf("if (channelsPostRequested(data.postToChannels))");
    expect(saveAt).toBeGreaterThan(0);
    expect(uploadAt).toBeGreaterThan(saveAt);
    expect(gateAt).toBeGreaterThan(uploadAt);
  });
});

describe("local archive", () => {
  test("reuses the 视频号 desktop folder and its override", () => {
    expect(localArchiveDir({ CHANNELS_DESKTOP_DIR: "/tmp/desk" }, "/tmp/home")).toBe(
      `/tmp/desk/${LOCAL_ARCHIVE_FOLDER}`,
    );
    expect(localArchiveDir({ CHANNELS_VIDEOS_DIR: "/tmp/videos", CHANNELS_DESKTOP_DIR: "/tmp/desk" }, "/tmp/home")).toBe(
      "/tmp/videos",
    );
    expect(localArchiveDir({}, "/tmp/home")).toBe(join("/tmp/home", "Desktop", LOCAL_ARCHIVE_FOLDER));
  });

  test("writes the submitted video into the local folder", () => {
    const root = mkdtempSync(join(tmpdir(), "bili-archive-"));
    const source = join(root, "source.mp4");
    const destDir = join(root, LOCAL_ARCHIVE_FOLDER);
    writeFileSync(source, "video-bytes");
    const saved = saveSubmittedVideos({
      title: "测试:标题",
      jobId: "job1",
      sources: [source],
      destDir,
    });
    expect(saved.dir).toBe(destDir);
    expect(saved.files).toHaveLength(1);
    expect(existsFile(saved.files[0])).toBe(true);
    expect(readFileSync(saved.files[0], "utf-8")).toBe("video-bytes");
    expect(saved.files[0]).toContain("测试_标题_job1.mp4");
  });
});

describe("视频号 command", () => {
  test("is only the local-draft command, not a download", () => {
    const planned = channelsDraftCommand({
      videoPath: "/tmp/clip.mp4",
      title: "标题",
      description: "简介",
      tags: ["标签"],
      bunBin: "/tmp/bun",
      channelsRoot: "/tmp/channels",
    });
    expect(planned.command).toBe("/tmp/bun");
    expect(planned.args).toContain("--local-video");
    expect(planned.args).toContain("/tmp/clip.mp4");
    expect(planned.args).toContain("--tag");
    expect(planned.args).toContain("标签");
    expect(planned.args.join(" ")).not.toContain("yt-dlp");
  });
});

function existsFile(path: string | undefined): boolean {
  return Boolean(path && readFileSync(path));
}
