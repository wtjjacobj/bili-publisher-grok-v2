import { spawn, type SpawnOptions } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

export const CHANNELS_ROOT =
  process.env.CHANNELS_POST_ASSISTANT_ROOT || "/Users/wangtangjie/Projects/channels-post-assistant";

export type ChannelsDraftInput = {
  videoPath: string;
  title: string;
  description: string;
  tags: string[];
  bunBin?: string;
  channelsRoot?: string;
};

export function channelsDraftCommand(input: ChannelsDraftInput): { command: string; args: string[]; cwd: string } {
  const root = input.channelsRoot || CHANNELS_ROOT;
  const bun = input.bunBin || process.env.BILI_BUN_BIN || "/Users/wangtangjie/.bun/bin/bun";
  const tags = input.tags.map(tag => tag.trim()).filter(Boolean);
  return {
    command: bun,
    cwd: root,
    args: [
      join(root, "src/cli.ts"),
      "--local-video",
      input.videoPath,
      "--title",
      input.title,
      "--desc",
      input.description || "",
      ...tags.flatMap(tag => ["--tag", tag]),
    ],
  };
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => { pid?: number; unref?: () => void };

export function startChannelsDraft(
  input: ChannelsDraftInput,
  spawnImpl: SpawnLike = spawn as SpawnLike,
): { started: true; pid?: number } {
  if (!existsSync(input.videoPath)) throw new Error(`视频号草稿找不到视频: ${input.videoPath}`);
  const cli = join(input.channelsRoot || CHANNELS_ROOT, "src/cli.ts");
  if (!existsSync(cli)) throw new Error(`找不到视频号投稿程序: ${cli}`);
  const planned = channelsDraftCommand(input);
  const child = spawnImpl(planned.command, planned.args, {
    cwd: planned.cwd,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref?.();
  return { started: true, pid: child.pid };
}
