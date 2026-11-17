import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const projectLauncher = join(import.meta.dir, "../scripts/launcher.sh");
const appLauncher = "/Users/wangtangjie/Desktop/B站投稿助手-Grok-v2.app/Contents/MacOS/launch.sh";

describe("desktop app launcher", () => {
  test("project launcher is self-contained and does not exec out of process", () => {
    const text = readFileSync(projectLauncher, "utf-8");
    expect(text.startsWith("#!/bin/bash")).toBe(true);
    expect(text).toContain("bili-publisher-grok-v2");
    expect(text).toContain("3459");
    expect(text).toContain("B站投稿-grok-v2");
    expect(text).toContain("server.ts");
    expect(text).not.toMatch(/^\s*exec\s+"/m);
  });

  test("desktop app launch.sh is a copy of the project launcher, not an exec wrapper", () => {
    if (!existsSync(appLauncher)) return;
    const appText = readFileSync(appLauncher, "utf-8");
    const projectText = readFileSync(projectLauncher, "utf-8");
    expect(appText).toBe(projectText);
    expect(appText).not.toMatch(/^\s*exec\s+"/m);
    expect(appText).toContain("/Users/wangtangjie/.bun/bin/bun");
  });
});
