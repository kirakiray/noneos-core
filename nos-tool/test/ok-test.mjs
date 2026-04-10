export default class OkTest extends HTMLElement {
  static templatePromise = null;
  static testQueue = [];
  static isRunning = false;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  static loadTemplate() {
    if (OkTest.templatePromise) {
      return OkTest.templatePromise;
    }

    OkTest.templatePromise = (async () => {
      try {
        const templateUrl = import.meta.resolve("./template.html");

        const response = await fetch(templateUrl);
        const html = await response.text();

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");

        return {
          styles: doc.querySelector("#ok-test-styles"),
          result: doc.querySelector("#ok-test-result"),
          error: doc.querySelector("#ok-test-error"),
        };
      } catch (err) {
        console.error("Failed to load template:", err);
        return null;
      }
    })();

    return OkTest.templatePromise;
  }

  async connectedCallback() {
    const templates = await OkTest.loadTemplate();
    const isParallel = this.hasAttribute("parallel");

    const executeTest = () => {
      const name = this.getAttribute("name") || "Unnamed Test";
      const template = this.querySelector("template");

      if (!template) {
        this.showError(name, "No template found", templates);
        return;
      }

      const script = template.content.querySelector("script");

      if (!script) {
        this.showError(name, "No script found in template", templates);
        return;
      }

      const code = script.textContent;
      return this.runTest(name, code, templates);
    };

    if (isParallel) {
      requestAnimationFrame(executeTest);
    } else {
      OkTest.testQueue.push({
        element: this,
        execute: executeTest,
      });

      requestAnimationFrame(() => {
        if (!OkTest.isRunning) {
          OkTest.processQueue();
        }
      });
    }
  }

  static async processQueue() {
    if (OkTest.testQueue.length === 0) {
      OkTest.isRunning = false;
      return;
    }

    OkTest.isRunning = true;
    const { execute } = OkTest.testQueue.shift();

    try {
      await execute();
    } catch (error) {
      console.error("Test execution error:", error);
    }

    OkTest.processQueue();
  }

  async runTest(name, code, templates) {
    let url = "";
    let sourceURL = window.location.href;
    try {
      let lineOffset = 0;
      let htmlContent = "";
      try {
        htmlContent = await fetch(window.location.href).then((r) => r.text());
        const codeIndex = htmlContent.indexOf(code);
        if (codeIndex !== -1) {
          lineOffset =
            htmlContent.substring(0, codeIndex).split("\n").length - 1;
        }
      } catch (e) {
        console.warn("Failed to fetch source for padding", e);
      }

      try {
        const urlObj = new URL(sourceURL);
        urlObj.searchParams.set("test", name.replace(/\s+/g, "-"));
        sourceURL = urlObj.toString();
      } catch (e) {
        // Fallback
      }

      let blobContent = "";
      if (htmlContent && lineOffset > 0) {
        const lines = htmlContent.split("\n");

        // 为了让行号绝对对齐（不增加额外行），我们把函数声明和第一行注释放在同一行
        lines[0] = `export default async function test() { // ${lines[0]}`;

        const beforeCode = lines
          .slice(0, lineOffset)
          .map((line, i) => (i === 0 ? line : `// ${line}`))
          .join("\n");
        const codeLineCount = code.split("\n").length;
        const afterCode = lines
          .slice(lineOffset + codeLineCount)
          .map((line) => `// ${line}`)
          .join("\n");

        blobContent = `${beforeCode}\n${code}\n${afterCode}\n}\n//# sourceURL=${sourceURL}`;
      } else {
        const padLines = "\n".repeat(Math.max(0, lineOffset));
        blobContent = `export default async function test() {${padLines}${code}\n}\n//# sourceURL=${sourceURL}`;
      }

      const blob = new Blob([blobContent], { type: "application/javascript" });
      url = URL.createObjectURL(blob);

      const module = await import(url);
      const result = await module.default();

      if (result && result.assert === true) {
        this.showResult(name, result, true, templates);
      } else {
        this.showResult(name, result, false, templates);
      }
    } catch (error) {
      if (error instanceof Error && error.stack && url) {
        // 修复 Safari 下错误堆栈显示 blob 虚拟地址的问题
        error.stack = error.stack.split(url).join(sourceURL);
      }
      this.showError(name, error, templates);
    }
  }

  showResult(name, result, success, templates) {
    const status = success ? "✓" : "✗";
    const attr = success ? "success" : "failure";

    this.setAttribute(attr, "");

    if (!templates || !templates.styles || !templates.result) {
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; padding: 12px; margin: 8px 0; }
          :host([success]) { background: #d4edda; border-left: 4px solid #28a745; }
          :host([failure]) { background: #f8d7da; border-left: 4px solid #dc3545; }
        </style>
        <div>${status} ${this.escapeHtml(name)}</div>
      `;
      return;
    }

    const stylesTemplate = templates.styles.content.cloneNode(true);
    const resultTemplate = templates.result.content.cloneNode(true);

    const statusEl = resultTemplate.querySelector(".status");
    const nameEl = resultTemplate.querySelector(".name");
    const errorMsgEl = resultTemplate.querySelector(".error-msg");
    const contentEl = resultTemplate.querySelector(".content");

    statusEl.textContent = status;
    nameEl.textContent = name;

    if (!success) {
      errorMsgEl.textContent = `Assertion failed: expected true but got ${result && result.assert}`;
    } else {
      errorMsgEl.remove();
    }

    if (result && result.content) {
      contentEl.textContent = JSON.stringify(result.content, null, 2);
    } else {
      contentEl.remove();
    }

    this.shadowRoot.appendChild(stylesTemplate);
    this.shadowRoot.appendChild(resultTemplate);
  }

  showError(name, error, templates) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : "";

    this.setAttribute("failure", "");

    if (!templates || !templates.styles || !templates.error) {
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; padding: 12px; margin: 8px 0; background: #f8d7da; border-left: 4px solid #dc3545; }
        </style>
        <div>✗ ${this.escapeHtml(name)}</div>
        <div>Error: ${this.escapeHtml(errorMsg)}</div>
      `;
      return;
    }

    const stylesTemplate = templates.styles.content.cloneNode(true);
    const errorTemplate = templates.error.content.cloneNode(true);

    const nameEl = errorTemplate.querySelector(".name");
    const errorMsgEl = errorTemplate.querySelector(".error-msg");
    const errorStackEl = errorTemplate.querySelector(".error-stack");

    nameEl.textContent = name;
    errorMsgEl.textContent = `Error: ${errorMsg}`;

    if (errorStack) {
      errorStackEl.textContent = errorStack;
    } else {
      errorStackEl.remove();
    }

    this.shadowRoot.appendChild(stylesTemplate);
    this.shadowRoot.appendChild(errorTemplate);
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}

customElements.define("ok-test", OkTest);
