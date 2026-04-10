class OkTest extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    requestAnimationFrame(() => {
      const name = this.getAttribute("name") || "Unnamed Test";
      const template = this.querySelector("template");

      if (!template) {
        this.showError(name, "No template found");
        return;
      }

      const script = template.content.querySelector("script");

      if (!script) {
        this.showError(name, "No script found in template");
        return;
      }

      const code = script.textContent;
      this.runTest(name, code);
    });
  }

  async runTest(name, code) {
    try {
      const testFunction = new Function(code);
      const result = await testFunction();

      if (result && result.assert === true) {
        this.showSuccess(name, result);
      } else {
        this.showFailure(name, result);
      }
    } catch (error) {
      this.showError(name, error);
    }
  }

  showSuccess(name, result) {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          padding: 12px;
          margin: 8px 0;
          background: #d4edda;
          border-left: 4px solid #28a745;
          border-radius: 4px;
          font-family: system-ui, -apple-system, sans-serif;
        }
        .test-name {
          font-weight: bold;
          color: #155724;
          margin-bottom: 4px;
        }
        .status {
          color: #28a745;
        }
        .content {
          margin-top: 8px;
          padding: 8px;
          background: rgba(255, 255, 255, 0.5);
          border-radius: 3px;
          font-size: 0.9em;
          color: #155724;
          white-space: pre-wrap;
          font-family: monospace;
        }
      </style>
      <div class="test-name">
        <span class="status">✓</span> ${this.escapeHtml(name)}
      </div>
      ${result && result.content ? `<div class="content">${this.escapeHtml(JSON.stringify(result.content, null, 2))}</div>` : ""}
    `;
  }

  showFailure(name, result) {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          padding: 12px;
          margin: 8px 0;
          background: #f8d7da;
          border-left: 4px solid #dc3545;
          border-radius: 4px;
          font-family: system-ui, -apple-system, sans-serif;
        }
        .test-name {
          font-weight: bold;
          color: #721c24;
          margin-bottom: 4px;
        }
        .status {
          color: #dc3545;
        }
        .error-msg {
          margin-top: 8px;
          padding: 8px;
          background: rgba(255, 255, 255, 0.5);
          border-radius: 3px;
          font-size: 0.9em;
          color: #721c24;
          font-family: monospace;
        }
        .content {
          margin-top: 8px;
          padding: 8px;
          background: rgba(255, 255, 255, 0.5);
          border-radius: 3px;
          font-size: 0.9em;
          color: #721c24;
          white-space: pre-wrap;
          font-family: monospace;
        }
      </style>
      <div class="test-name">
        <span class="status">✗</span> ${this.escapeHtml(name)}
      </div>
      <div class="error-msg">Assertion failed: expected true but got ${result && result.assert}</div>
      ${result && result.content ? `<div class="content">${this.escapeHtml(JSON.stringify(result.content, null, 2))}</div>` : ""}
    `;
  }

  showError(name, error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : "";

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          padding: 12px;
          margin: 8px 0;
          background: #f8d7da;
          border-left: 4px solid #dc3545;
          border-radius: 4px;
          font-family: system-ui, -apple-system, sans-serif;
        }
        .test-name {
          font-weight: bold;
          color: #721c24;
          margin-bottom: 4px;
        }
        .status {
          color: #dc3545;
        }
        .error-msg {
          margin-top: 8px;
          padding: 8px;
          background: rgba(255, 255, 255, 0.5);
          border-radius: 3px;
          font-size: 0.9em;
          color: #721c24;
          font-family: monospace;
        }
        .error-stack {
          margin-top: 8px;
          padding: 8px;
          background: rgba(0, 0, 0, 0.05);
          border-radius: 3px;
          font-size: 0.85em;
          color: #721c24;
          white-space: pre-wrap;
          font-family: monospace;
          overflow-x: auto;
        }
      </style>
      <div class="test-name">
        <span class="status">✗</span> ${this.escapeHtml(name)}
      </div>
      <div class="error-msg">Error: ${this.escapeHtml(errorMsg)}</div>
      ${errorStack ? `<div class="error-stack">${this.escapeHtml(errorStack)}</div>` : ""}
    `;
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}

customElements.define("ok-test", OkTest);
