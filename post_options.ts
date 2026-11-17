import { copyFileSync, existsSync, mkdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, extname, join } from "path";

/** Same folder the 视频号 app already uses (`CHANNELS_VIDEOS_DIR` / desktop `视频号投稿视频`). */
export const LOCAL_ARCHIVE_FOLDER = "视频号投稿视频";
export const CHANNELS_CHECKBOX_ID = "channelsPostCheck";
export const CHANNELS_CHECKBOX_LABEL = "同时投稿到微信视频号";

export function channelsPostRequested(value: unknown): boolean {
  return value === true;
}

export function publishExtras(postToChannels: unknown): { saveLocal: true; postChannels: boolean } {
  return { saveLocal: true, postChannels: channelsPostRequested(postToChannels) };
}

export function localArchiveDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.CHANNELS_VIDEOS_DIR?.trim();
  if (override) return override;
  const desktop = env.CHANNELS_DESKTOP_DIR?.trim() || join(home, "Desktop");
  return join(desktop, LOCAL_ARCHIVE_FOLDER);
}

export function safeArchiveTitle(title: string): string {
  const cleaned = String(title || "")
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 40);
  return cleaned || "video";
}

function sameFile(left: string, right: string): boolean {
  try {
    const a = statSync(left);
    const b = statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

export function archiveDestinations(input: {
  title: string;
  jobId: string;
  sources: string[];
  destDir: string;
}): string[] {
  const base = safeArchiveTitle(input.title);
  return input.sources.map((source, index) => {
    const ext = extname(source).toLowerCase() || ".mp4";
    const part = input.sources.length > 1 ? `_p${index + 1}` : "";
    return join(input.destDir, `${base}_${input.jobId}${part}${ext}`);
  });
}

export function saveSubmittedVideos(input: {
  title: string;
  jobId: string;
  sources: string[];
  destDir: string;
}): { dir: string; files: string[] } {
  if (!input.sources.length) throw new Error("没有可保存的投稿视频");
  mkdirSync(input.destDir, { recursive: true });
  const destinations = archiveDestinations(input);
  const files: string[] = [];
  input.sources.forEach((source, index) => {
    if (!existsSync(source)) throw new Error(`投稿视频不存在: ${basename(source)}`);
    const destination = destinations[index];
    if (!destination) throw new Error("本地保存路径无效");
    if (source !== destination && !sameFile(source, destination)) {
      copyFileSync(source, destination);
    }
    if (!existsSync(destination) && !existsSync(source)) {
      throw new Error(`本地保存失败: ${basename(destination)}`);
    }
    files.push(existsSync(destination) ? destination : source);
  });
  return { dir: input.destDir, files };
}
