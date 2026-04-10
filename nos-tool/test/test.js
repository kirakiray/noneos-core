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
      const testFunction = new Function(`return (async () => { ${code} })()`);
      const result = await testFunction();

      if (result && result.assert === true) {
        this.showResult(name, result, true);
      } else {
        this.showResult(name, result, false);
      }
    } catch (error) {
      this.showError(name, error);
    }
  }

  showResult(name, result, success) {
    const status = success ? "✓" : "✗";
    const attr = success ? "success" : "failure";
    
    this.setAttribute(attr, "");
    
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          padding: 12px;
          margin: 8px 0;
          border-radius: 4px;
          font-family: system-ui, -apple-system, sans-serif;
        }
        :host([success]) {
          background: #d4edda;
          border-left: 4px solid #28a745;
        }
        :host([failure]) {
          background: #f8d7da;
          border-left: 4px solid #dc3545;
        }
        :host([success]) .test-name {
          color: #155724;
        }
        :host([failure]) .test-name {
          color: #721c24;
        }
        :host([success]) .status {
          color: #28a745;
        }
        :host([failure]) .status {
          color: #dc3545;
        }
        :host([success]) .content,
        :host([success]) .error-msg {
          color: #155724;
        }
        :host([failure]) .content,
        :host([failure]) .error-msg {
          color: #721c24;
        }
        .test-name {
          font-weight: bold;
          margin-bottom: 4px;
        }
        .content {
          margin-top: 8px;
          padding: 8px;
          background: rgba(255, 255, 255, 0.5);
          border-radius: 3px;
          font-size: 0.9em;
          white-space: pre-wrap;
          font-family: monospace;
        }
        .error-msg {
          margin-top: 8px;
          padding: 8px;
          background: rgba(255, 255, 255, 0.5);
          border-radius: 3px;
          font-size: 0.9em;
          font-family: monospace;
        }
      </style>
      <div class="test-name">
        <span class="status">${status}</span> ${this.escapeHtml(name)}
      </div>
      ${!success ? `<div class="error-msg">Assertion failed: expected true but got ${result && result.assert}</div>` : ""}
      ${result && result.content ? `<div class="content">${this.escapeHtml(JSON.stringify(result.content, null, 2))}</div>` : ""}
    `;
  }

  showError(name, error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : "";

    this.setAttribute("failure", "");

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          padding: 12px;
          margin: 8px 0;
          border-radius: 4px;
          font-family: system-ui, -apple-system, sans-serif;
        }
        :host([failure]) {
          background: #f8d7da;
          border-left: 4px solid #dc3545;
        }
        :host([failure]) .test-name {
          color: #721c24;
        }
        :host([failure]) .status {
          color: #dc3545;
        }
        :host([failure]) .error-msg,
        :host([failure]) .error-stack {
          color: #721c24;
        }
        .test-name {
          font-weight: bold;
          margin-bottom: 4px;
        }
        .error-msg {
          margin-top: 8px;
          padding: 8px;
          background: rgba(255, 255, 255, 0.5);
          border-radius: 3px;
          font-size: 0.9em;
          font-family: monospace;
        }
        .error-stack {
          margin-top: 8px;
          padding: 8px;
          background: rgba(0, 0, 0, 0.05);
          border-radius: 3px;
          font-size: 0.85em;
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
