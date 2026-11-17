import { describe, expect, test } from "bun:test";

await import("../public/ui_helpers.js");
const helpers = (globalThis as any).BiliUiHelpers;

class FakeClassList {
  private values = new Set<string>();

  add(...names: string[]) { names.forEach(name => this.values.add(name)); }
  remove(...names: string[]) { names.forEach(name => this.values.delete(name)); }
  toggle(name: string, force?: boolean) {
    const enabled = force === undefined ? !this.values.has(name) : force;
    if (enabled) this.values.add(name); else this.values.delete(name);
    return enabled;
  }
  contains(name: string) { return this.values.has(name); }
}

class FakeElement {
  readonly classList = new FakeClassList();
  readonly style: { display: string } = { display: "" };
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((event: any) => void)[]>();
  parentElement: FakeElement | null = null;
  textContent = "";
  type = "";

  constructor(readonly tagName: string) {}

  append(...nodes: FakeElement[]) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: FakeElement[]) {
    this.children.splice(0);
    this.append(...nodes);
  }

  before(node: FakeElement) {
    const parent = this.parentElement;
    if (!parent) return;
    const currentIndex = parent.children.indexOf(node);
    if (currentIndex >= 0) parent.children.splice(currentIndex, 1);
    const targetIndex = parent.children.indexOf(this);
    node.parentElement = parent;
    parent.children.splice(targetIndex, 0, node);
  }

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }
  click() { (this.listeners.get("click") || []).forEach(listener => listener({})); }
  keydown(key: string) {
    let prevented = false;
    (this.listeners.get("keydown") || []).forEach(listener => listener({ key, preventDefault() { prevented = true; } }));
    return prevented;
  }
}

function createTitleDom() {
  const titleCard = new FakeElement("div");
  const warning = new FakeElement("div");
  const candidates = new FakeElement("div");
  const customTitle = new FakeElement("input") as FakeElement & { value: string };
  customTitle.value = "保留的旧标题";
  titleCard.append(candidates, warning, customTitle);
  return {
    document: { createElement: (tagName: string) => new FakeElement(tagName) },
    titleCard, warning, candidates, customTitle,
  };
}

function renderTitles(data: unknown, dom = createTitleDom()) {
  let selectedTitle = "旧状态";
  helpers.renderTitleChoices(data, {
    ...dom,
    onSelected(title: string) { selectedTitle = title; },
  });
  return { ...dom, get selectedTitle() { return selectedTitle; } };
}

describe("browser-safe metadata UI helpers", () => {
  test("resolves a valid recommendation and falls back to the legacy first title", () => {
    expect(helpers.resolveRecommendedTitleIndex({
      recommended_title_index: 2,
      title_candidates: ["标题甲", "标题乙", "推荐标题"],
    })).toBe(2);
    expect(helpers.resolveRecommendedTitleIndex({
      recommended_title_index: 9,
      title_candidates: ["旧标题"],
    })).toBe(0);
    expect(helpers.resolveRecommendedTitleIndex({
      title_candidates: ["旧标题", "第二条"],
    })).toBe(0);
  });

  test("labels speech as understanding only and never as generated subtitles", () => {
    expect(helpers.speechStatusCopy(true)).toBe("检测到语音 · 仅用于理解");
    expect(helpers.speechStatusCopy(false)).toBe("无明显语音 · 未生成字幕");
    expect(helpers.speechStatusCopy(null)).toBe("原视频 · 未处理字幕");
    expect(helpers.speechStatusCopy(undefined)).toBe("原视频 · 未处理字幕");
  });
});

describe("title-choice rendering behavior", () => {
  test("renders exactly one accessible recommended native button and selects the valid recommendation", () => {
    const rendered = renderTitles({
      copy_status: "approved",
      recommended_title_index: 2,
      title_candidates: ["标题甲", "标题乙", "推荐标题"],
    });
    const buttons = rendered.candidates.children;

    expect(rendered.titleCard.style.display).toBe("");
    expect(rendered.warning.style.display).toBe("none");
    expect(rendered.titleCard.children.indexOf(rendered.warning)).toBeLessThan(rendered.titleCard.children.indexOf(rendered.candidates));
    expect(buttons).toHaveLength(3);
    expect(buttons.every(button => button.tagName === "button" && button.type === "button")).toBe(true);
    expect(buttons.every(button => button.getAttribute("aria-pressed") !== null)).toBe(true);
    expect(buttons.filter(button => button.children.some(child => child.textContent === "推荐"))).toHaveLength(1);
    expect(buttons[2].classList.contains("selected")).toBe(true);
    expect(buttons[2].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[2].getAttribute("aria-label")).toContain("推荐");
    expect(rendered.selectedTitle).toBe("推荐标题");
  });

  test("uses the first title for invalid or missing recommendations and updates selection through click and keyboard", () => {
    const rendered = renderTitles({
      recommended_title_index: 99,
      title_candidates: ["旧标题", "另一个标题"],
    });
    const buttons = rendered.candidates.children;

    expect(rendered.selectedTitle).toBe("旧标题");
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    buttons[1].click();
    expect(rendered.selectedTitle).toBe("另一个标题");
    expect(buttons[0].getAttribute("aria-pressed")).toBe("false");
    expect(buttons[1].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1].classList.contains("selected")).toBe(true);
    expect(buttons[0].keydown("Enter")).toBe(true);
    expect(rendered.selectedTitle).toBe("旧标题");
    expect(buttons[1].keydown(" ")).toBe(true);
    expect(rendered.selectedTitle).toBe("另一个标题");
  });

  test("shows the review warning only for needs-review results and clears all stale state on an empty rerender", () => {
    const dom = createTitleDom();
    let selectedTitle = "";
    const onSelected = (title: string) => { selectedTitle = title; };
    helpers.renderTitleChoices({
      copy_status: "needs_review",
      title_candidates: ["需要检查的标题"],
    }, { ...dom, onSelected });

    expect(dom.warning.style.display).toBe("");
    expect(dom.warning.textContent).toContain("Grok 已生成文案，建议核对后再保存");
    expect(selectedTitle).toBe("需要检查的标题");

    helpers.renderTitleChoices({ copy_status: "approved" }, { ...dom, onSelected });
    expect(dom.titleCard.style.display).toBe("none");
    expect(dom.warning.style.display).toBe("none");
    expect(dom.warning.textContent).toBe("");
    expect(dom.candidates.children).toHaveLength(0);
    expect(dom.customTitle.value).toBe("");
    expect(selectedTitle).toBe("");
  });
});

describe("approvals and branches", () => {
  test("renders unacknowledged approvals and hides when empty", () => {
    const container = new FakeElement("div");
    container.style.display = "";
    const ids: string[] = [];
    const count = helpers.renderApprovalList(
      [{ id: "u1", summary: "不确定：马的身份", acknowledged: false }, { id: "u2", summary: "已确认", acknowledged: true }],
      { document: { createElement: (tagName: string) => new FakeElement(tagName) }, container, onAck: (id: string) => ids.push(id) },
    );
    expect(count).toBe(1);
    expect(container.children).toHaveLength(1);
    expect(container.style.display).toBe("");
    expect(helpers.renderApprovalList([], { document: { createElement: (tagName: string) => new FakeElement(tagName) }, container, onAck() {} })).toBe(0);
    expect(container.style.display).toBe("none");
  });

  test("renders title branches", () => {
    const container = new FakeElement("div");
    const applied: string[] = [];
    helpers.renderBranchList(
      [{ id: "alt1", label: "更具体", titles: ["蒙古派对闯入一匹马"] }],
      { document: { createElement: (tagName: string) => new FakeElement(tagName) }, container, onApply: (id: string) => applied.push(id) },
    );
    expect(container.children).toHaveLength(1);
    container.children[0].children[1].click();
    expect(applied).toEqual(["alt1"]);
  });

  test("extracts a pasted video URL and recognizes prepare failures", () => {
    expect(helpers.extractVideoUrl("  看看 https://youtu.be/x7nc9Mk7Lzs?si=abc。 ")).toBe("https://youtu.be/x7nc9Mk7Lzs?si=abc");
    expect(helpers.extractVideoUrl("https://x.com/user/status/1")).toBe("https://x.com/user/status/1");
    expect(helpers.isPrepareFailure("YouTube 拒绝下载（403）。过几分钟再试。")).toBe(true);
    expect(helpers.isPrepareFailure("视频链接不能指向本机或内网地址")).toBe(true);
    expect(helpers.isPrepareFailure("YouTube 默认线路被拒绝，正在换备用线路")).toBe(false);
    expect(helpers.isPrepareFailure("正在下载视频")).toBe(false);
  });
});
