import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

export const BRANCHES_DIR = "branches";

export interface TitleBranch {
  id: string;
  label: string;
  createdAt: string;
  source: "current" | "chat";
  result: Record<string, unknown>;
}

function branchDir(artifactDir: string): string {
  return join(artifactDir, BRANCHES_DIR);
}

export function createTitleBranch(
  artifactDir: string,
  input: { label: string; result: Record<string, unknown>; source?: "current" | "chat"; id?: string },
): TitleBranch {
  const branch: TitleBranch = {
    id: input.id || randomUUID().slice(0, 8),
    label: input.label.trim() || "标题试验",
    createdAt: new Date().toISOString(),
    source: input.source || "chat",
    result: input.result,
  };
  const directory = branchDir(artifactDir);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${branch.id}.json`);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(branch, null, 2)}\n`);
  renameSync(temporary, path);
  return branch;
}

export function listTitleBranches(artifactDir: string): TitleBranch[] {
  const directory = branchDir(artifactDir);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => name.endsWith(".json"))
    .map(name => {
      try {
        return JSON.parse(readFileSync(join(directory, name), "utf-8")) as TitleBranch;
      } catch {
        return null;
      }
    })
    .filter((item): item is TitleBranch => Boolean(item && item.id && item.result))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

export function readTitleBranch(artifactDir: string, branchId: string): TitleBranch {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(branchId)) throw new Error("无效的标题分支");
  const path = join(branchDir(artifactDir), `${branchId}.json`);
  if (!existsSync(path)) throw new Error("标题分支不存在");
  const branch = JSON.parse(readFileSync(path, "utf-8")) as TitleBranch;
  if (!branch?.id || !branch.result) throw new Error("标题分支损坏");
  return branch;
}

export function summarizeBranch(branch: TitleBranch): {
  id: string;
  label: string;
  createdAt: string;
  source: string;
  titles: string[];
} {
  const titles = Array.isArray(branch.result.title_candidates)
    ? branch.result.title_candidates.map(item => String(item))
    : [];
  return {
    id: branch.id,
    label: branch.label,
    createdAt: branch.createdAt,
    source: branch.source,
    titles,
  };
}
