import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appendCallTrace, readCallTraces } from "../job_trace";
import { appendStageEvent, readStageEvents } from "../job_events";

function withTempDir(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "job-trace-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("job traces and stage events", () => {
  test("appends model calls without deleting previous entries", () => {
    withTempDir(directory => {
      appendCallTrace(directory, {
        stage: "analysis",
        attempt: 1,
        model: "grok-4.6",
        ok: true,
        durationMs: 12,
        promptChars: 100,
        imageCount: 10,
        outputFile: "out.json",
      });
      appendCallTrace(directory, {
        stage: "draft",
        attempt: 1,
        model: "grok-4.6",
        ok: false,
        durationMs: 9,
        promptChars: 80,
        imageCount: 0,
        error: "timeout",
      });
      const traces = readCallTraces(directory);
      expect(traces).toHaveLength(2);
      expect(traces[0].stage).toBe("analysis");
      expect(traces[1].ok).toBe(false);
      expect(traces[1].error).toBe("timeout");
    });
  });

  test("records stage events in order", () => {
    withTempDir(directory => {
      appendStageEvent(directory, { stage: "analysis", status: "started", message: "开始分析" });
      appendStageEvent(directory, { stage: "analysis", status: "completed", message: "事实卡完成", model: "grok-4.6" });
      const events = readStageEvents(directory);
      expect(events.map(event => event.status)).toEqual(["started", "completed"]);
      expect(events[1].model).toBe("grok-4.6");
    });
  });
});
