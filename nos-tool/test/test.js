class OkTest extends HTMLElement {
  static templatePromise = null;

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
        const currentScript = document.currentScript;
        const scriptUrl = currentScript ? currentScript.src : "";
        const templateUrl = scriptUrl
          ? scriptUrl.replace(/test\.js$/, "template.html")
          : "./template.html";

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

    requestAnimationFrame(() => {
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
      this.runTest(name, code, templates);
    });
  }

  async runTest(name, code, templates) {
    try {
      let lineOffset = 0;
      let htmlContent = '';
      try {
        htmlContent = await fetch(window.location.href).then(r => r.text());
        const codeIndex = htmlContent.indexOf(code);
        if (codeIndex !== -1) {
          lineOffset = htmlContent.substring(0, codeIndex).split('\n').length - 1;
        }
      } catch (e) {
        console.warn('Failed to fetch source for padding', e);
      }
      
      let sourceURL = window.location.href;
      try {
        const urlObj = new URL(sourceURL);
        urlObj.searchParams.set('test', name.replace(/\s+/g, '-'));
        sourceURL = urlObj.toString();
      } catch (e) {
        // Fallback
      }

      // 将源代码完整地包裹起来，这样断点时能看到完整的上下文（包括HTML）
      // 将不在当前 test script 内的内容变成注释，以保证它是一段合法的 JavaScript 代码
      let fullSourceCode = code;
      if (htmlContent && lineOffset > 0) {
        const lines = htmlContent.split('\n');
        // 将 code 之前的内容注释掉
        const beforeCode = lines.slice(0, lineOffset).map(line => `// ${line}`).join('\n');
        // 找到 code 结束的行号
        const codeLineCount = code.split('\n').length;
        // 将 code 之后的内容注释掉
        const afterCode = lines.slice(lineOffset + codeLineCount).map(line => `// ${line}`).join('\n');
        
        fullSourceCode = `${beforeCode}\n${code}\n${afterCode}`;
      } else {
        const padLines = '\n'.repeat(Math.max(0, lineOffset));
        fullSourceCode = `${padLines}${code}`;
      }

      const blobContent = `export default async function test() {\n// --- BEGIN TEST --- \n${fullSourceCode}\n// --- END TEST ---\n}\n//# sourceURL=${sourceURL}`;
      const blob = new Blob([blobContent], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);

      const module = await import(url);
      const result = await module.default();

      if (result && result.assert === true) {
        this.showResult(name, result, true, templates);
      } else {
        this.showResult(name, result, false, templates);
      }
    } catch (error) {
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
