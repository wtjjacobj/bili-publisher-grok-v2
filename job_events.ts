import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

export const STAGE_EVENT_FILE = "traces/events.jsonl";

export type StageName =
  | "prepare"
  | "download"
  | "media"
  | "covers"
  | "analysis"
  | "lookup"
  | "draft"
  | "review"
  | "rewrite"
  | "complete";

export type StageStatus = "started" | "completed" | "failed" | "skipped";

export interface StageEvent {
  ts: string;
  type: "stage";
  stage: StageName | string;
  status: StageStatus;
  message: string;
  attempt?: number;
  model?: string;
}

export function stageEventPath(artifactDir: string): string {
  return join(artifactDir, STAGE_EVENT_FILE);
}

export function appendStageEvent(
  artifactDir: string,
  event: Omit<StageEvent, "ts" | "type"> & { ts?: string },
): StageEvent {
  const entry: StageEvent = {
    ts: event.ts || new Date().toISOString(),
    type: "stage",
    stage: event.stage,
    status: event.status,
    message: event.message,
  };
  if (event.attempt !== undefined) entry.attempt = event.attempt;
  if (event.model) entry.model = event.model;
  const path = stageEventPath(artifactDir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
  return entry;
}

export function readStageEvents(artifactDir: string): StageEvent[] {
  const path = stageEventPath(artifactDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as StageEvent];
      } catch {
        return [];
      }
    });
}
