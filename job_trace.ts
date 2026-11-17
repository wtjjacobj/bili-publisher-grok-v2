import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

export const CALL_TRACE_FILE = "traces/calls.jsonl";

export interface ModelCallTrace {
  ts: string;
  stage: string;
  attempt: number;
  model: string;
  ok: boolean;
  durationMs: number;
  promptChars: number;
  imageCount: number;
  outputFile?: string;
  error?: string;
}

export function callTracePath(artifactDir: string): string {
  return join(artifactDir, CALL_TRACE_FILE);
}

export function appendCallTrace(artifactDir: string, record: Omit<ModelCallTrace, "ts"> & { ts?: string }): ModelCallTrace {
  const entry: ModelCallTrace = {
    ts: record.ts || new Date().toISOString(),
    stage: record.stage,
    attempt: record.attempt,
    model: record.model,
    ok: record.ok,
    durationMs: record.durationMs,
    promptChars: record.promptChars,
    imageCount: record.imageCount,
  };
  if (record.outputFile) entry.outputFile = record.outputFile;
  if (record.error) entry.error = record.error.slice(0, 300);
  const path = callTracePath(artifactDir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
  return entry;
}

export function readCallTraces(artifactDir: string): ModelCallTrace[] {
  const path = callTracePath(artifactDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as ModelCallTrace];
      } catch {
        return [];
      }
    });
}
