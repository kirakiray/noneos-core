export function createCaseWizard({
  steps,
  railElement,
  stepElements,
  prevButton,
  nextButton,
  progressElement,
  counterElement,
  onEnter,
  onLeave,
}) {
  let current = 0;
  let busy = false;

  const rail = railElement;
  const stepNodes = [...stepElements];
  const prev = prevButton;
  const next = nextButton;
  const progress = progressElement;
  const counter = counterElement;

  function render() {
    for (const [index, node] of stepNodes.entries()) {
      node.classList.toggle("is-active", index === current);
    }
    for (const [index, item] of rail.ele.querySelectorAll("[data-step]").entries()) {
      item.setAttribute("aria-current", index === current ? "step" : "false");
    }
    progress.css = { width: `${((current + 1) / steps.length) * 100}%` };
    counter.text = `${current + 1} / ${steps.length}`;
    prev.attr("disabled", current === 0 || busy ? "" : null);
    next.attr("disabled", current === steps.length - 1 || busy ? "" : null);
    next.text = current === steps.length - 1 ? "已完成" : "下一步";
  }

  async function go(index) {
    if (busy || index < 0 || index >= steps.length || index === current) return;
    busy = true;
    render();
    try {
      if (onLeave) await onLeave(current, index);
      const previous = current;
      current = index;
      render();
      if (onEnter) await onEnter(index, previous);
    } finally {
      busy = false;
      render();
    }
  }

  async function rerun() {
    if (busy) return;
    busy = true;
    render();
    try {
      if (onEnter) await onEnter(current, current);
    } finally {
      busy = false;
      render();
    }
  }

  async function start() {
    if (busy) return;
    busy = true;
    render();
    try {
      if (onEnter) await onEnter(0, -1);
    } finally {
      busy = false;
      render();
    }
  }

  const items = steps
    .map(
      (step, index) => `
        <li>
          <button class="case-step-link" type="button" data-step="${index}" aria-current="false">
            <span class="case-step-index">${String(index + 1).padStart(2, "0")}</span>
            <span>
              <strong>${step.title}</strong>
              <small>${step.description || ""}</small>
            </span>
          </button>
        </li>`,
    )
    .join("");
  rail.html = items;
  rail.on("click", (event) => {
    const button = event.target.closest("[data-step]");
    if (!button) return;
    const index = Number(button.dataset.step);
    if (index < current) go(index);
  });

  prev.on("click", () => go(current - 1));
  next.on("click", () => go(current + 1));
  render();

  return {
    start,
    rerun,
    get current() {
      return current;
    },
    go,
    next: () => go(current + 1),
    prev: () => go(current - 1),
    render,
  };
}

export function setStatus(element, text, kind = "") {
  element.text = text;
  element.attr("class", `case-status ${kind}`.trim());
}

export function createCodeHistory(element) {
  const entries = new Map();
  let active = 0;
  const fence = "```";

  function render() {
    const parts = [...entries.entries()]
      .filter(([index]) => index <= active)
      .sort(([a], [b]) => a - b)
      .map(([index, entry]) => {
        const current = index === active ? "（当前）" : "";
        return [
          `### Step ${String(index + 1).padStart(2, "0")} · ${entry.title}${current}`,
          "",
          `${fence}js`,
          entry.code.trim(),
          fence,
        ].join("\n");
      });
    element.ele.value = parts.join("\n\n---\n\n");
    setTimeout(() => {
      const scroller = element.ele.closest(".case-code");
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }, 80);
  }

  return {
    set(index, title, code) {
      active = index;
      entries.set(index, { title, code });
      render();
    },
    render,
  };
}
