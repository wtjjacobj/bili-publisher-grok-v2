(function (global) {
  "use strict";

  function resolveRecommendedTitleIndex(result) {
    const titles = result && Array.isArray(result.title_candidates) ? result.title_candidates : [];
    const index = result && result.recommended_title_index;
    return Number.isInteger(index) && index >= 0 && index < titles.length ? index : 0;
  }

  function speechStatusCopy(hasSpeech) {
    if (hasSpeech === true) return "检测到语音 · 仅用于理解";
    if (hasSpeech === false) return "无明显语音 · 未生成字幕";
    return "原视频 · 未处理字幕";
  }

  function clearTitleChoiceSelection(container) {
    for (const choice of container.children) {
      choice.classList.remove("selected");
      choice.setAttribute("aria-pressed", "false");
    }
  }

  function renderTitleChoices(result, options) {
    const { document, titleCard, warning, candidates, customTitle, onSelected } = options;
    const titles = result && Array.isArray(result.title_candidates) ? result.title_candidates : [];

    candidates.before(warning);
    titleCard.style.display = "none";
    warning.textContent = "";
    warning.style.display = "none";
    candidates.replaceChildren();
    customTitle.value = "";
    onSelected("");

    if (titles.length === 0) return 0;

    titleCard.style.display = "";
    if (result.copy_status === "needs_review") {
      const issues = []
        .concat(result.review_issues || [], result.deterministic_issues || [])
        .filter(Boolean)
        .filter(issue => !String(issue).includes("仍保留 Grok"));
      warning.textContent = issues.length
        ? `Grok 已生成文案，建议核对后再保存。${issues.slice(0, 3).join("；")}`
        : "Grok 已生成文案，建议核对后再保存草稿";
      warning.style.display = "";
    }
    candidates.setAttribute("role", "group");
    candidates.setAttribute("aria-label", "标题候选");

    const recommendedIndex = resolveRecommendedTitleIndex(result);
    const choices = titles.map((title, index) => {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.classList.add("title-option");
      choice.setAttribute("aria-pressed", "false");
      choice.textContent = title;
      if (index === recommendedIndex) {
        choice.classList.add("recommended");
        choice.setAttribute("aria-label", `${title}（推荐）`);
        const badge = document.createElement("span");
        badge.classList.add("recommended-title-badge");
        badge.textContent = "推荐";
        choice.append(badge);
      }
      candidates.append(choice);
      return choice;
    });

    function select(index) {
      clearTitleChoiceSelection(candidates);
      const choice = choices[index];
      choice.classList.add("selected");
      choice.setAttribute("aria-pressed", "true");
      customTitle.value = "";
      onSelected(titles[index]);
    }

    choices.forEach((choice, index) => {
      choice.addEventListener("click", () => select(index));
      choice.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          choice.click();
        }
      });
    });
    select(recommendedIndex);
    return recommendedIndex;
  }

  function renderApprovalList(items, options) {
    const { document, container, onAck } = options;
    container.replaceChildren();
    const pending = (items || []).filter(item => item && !item.acknowledged);
    if (pending.length === 0) {
      container.style.display = "none";
      return 0;
    }
    container.style.display = "";
    pending.forEach(item => {
      const row = document.createElement("label");
      row.className = "approval-item";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.setAttribute("data-approval-id", String(item.id || ""));
      box.addEventListener("change", () => {
        if (box.checked) onAck(box.getAttribute("data-approval-id"));
      });
      const text = document.createElement("span");
      text.textContent = String(item.summary || item.id);
      row.append(box, text);
      container.append(row);
    });
    return pending.length;
  }

  function extractVideoUrl(raw) {
    const text = String(raw || "").trim();
    const match = text.match(/https?:\/\/[^\s<>"']+/i);
    if (!match) return text;
    return match[0].replace(/[)\].,，。>]+$/g, "");
  }

  function isPrepareFailure(message) {
    return /失败|拒绝下载|403|超时|不可用|未连接|看不了|未通过|无效|不能/.test(String(message || ""));
  }

  function renderBranchList(branches, options) {
    const { document, container, onApply } = options;
    container.replaceChildren();
    if (!Array.isArray(branches) || branches.length === 0) {
      container.style.display = "none";
      return 0;
    }
    container.style.display = "";
    branches.forEach(branch => {
      const row = document.createElement("div");
      row.className = "branch-item";
      const titles = Array.isArray(branch.titles) ? branch.titles : [];
      const info = document.createElement("div");
      info.className = "branch-info";
      info.textContent = `${branch.label || "标题试验"}：${titles[0] || "无标题"}`;
      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "btn";
      apply.textContent = "采用这组";
      apply.addEventListener("click", () => onApply(branch.id));
      row.append(info, apply);
      container.append(row);
    });
    return branches.length;
  }

  global.BiliUiHelpers = {
    resolveRecommendedTitleIndex,
    speechStatusCopy,
    clearTitleChoiceSelection,
    renderTitleChoices,
    renderApprovalList,
    renderBranchList,
    extractVideoUrl,
    isPrepareFailure,
  };
})(globalThis);
