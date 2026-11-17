import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTitleBranch, listTitleBranches, readTitleBranch } from "../title_branches";

describe("title branches", () => {
  test("stores a branch without touching result.json", () => {
    const directory = mkdtempSync(join(tmpdir(), "branches-"));
    try {
      const branch = createTitleBranch(directory, {
        id: "alt1",
        label: "更具体",
        result: { title_candidates: ["蒙古派对闯入一匹马", "二", "三", "四", "五"] },
      });
      expect(branch.id).toBe("alt1");
      expect(listTitleBranches(directory)).toHaveLength(1);
      expect(readTitleBranch(directory, "alt1").result.title_candidates[0]).toBe("蒙古派对闯入一匹马");
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
