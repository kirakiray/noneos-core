export default class OkGroupTest extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.totalTests = 0;
    this.successTests = 0;
    this.errorTests = 0;
    this.iframes = new Map(); // src -> { iframe, total, success, error, results: [] }
    this.expandedGroups = new Set(); // 存储展开状态的 group url
    this.pendingUrls = [];
    this.currentUrl = null;
    
    this.handleMessage = this.handleMessage.bind(this);
    this.toggleGroup = this.toggleGroup.bind(this);
  }

  connectedCallback() {
    window.addEventListener("message", this.handleMessage);

    const includes = this.querySelectorAll("include");
    this.pendingUrls = Array.from(includes).map(inc => inc.getAttribute("src")).filter(Boolean).map(url => new URL(url, window.location.href).toString());

    this.render();
    this.runNextIframe();
  }

  runNextIframe() {
    if (this.pendingUrls.length === 0) return;
    
    const absoluteUrl = this.pendingUrls.shift();
    this.currentUrl = absoluteUrl;
    
    const iframe = document.createElement("iframe");
    iframe.src = absoluteUrl;
    // hide the iframe visually, but it must execute
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "none";
    iframe.style.position = "absolute";
    iframe.style.visibility = "hidden";
    this.shadowRoot.appendChild(iframe);

    this.iframes.set(absoluteUrl, {
      iframe,
      total: -1, // Initialize total to -1 to distinguish from actual 0 tests
      success: 0,
      error: 0,
      results: []
    });
    
    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener("message", this.handleMessage);
  }

  handleMessage(event) {
    const data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.type === "ok-test-count") {
      const url = data.url;
      const iframeData = this.iframes.get(url);
      if (iframeData) {
        iframeData.total = data.count;
        this.updateCounts();
        
        // Handle case where iframe has 0 tests or all tests are already finished
        if (url === this.currentUrl && iframeData.results.length === data.count) {
           this.runNextIframe();
        }
      }
    } else if (data.type === "ok-test-result") {
      const url = data.url;
      const iframeData = this.iframes.get(url);
      if (iframeData) {
        if (data.success) {
          iframeData.success++;
        } else {
          iframeData.error++;
        }
        iframeData.results.push(data);
        this.updateCounts();
        
        // 如果当前 iframe 的所有测试都跑完了，启动下一个 (total 必须已经被设置且不为 -1)
        if (url === this.currentUrl && iframeData.total !== -1 && iframeData.results.length === iframeData.total) {
          this.runNextIframe();
        }
      }
    }
  }

  toggleGroup(url) {
    if (this.expandedGroups.has(url)) {
      this.expandedGroups.delete(url);
    } else {
      this.expandedGroups.add(url);
    }
    this.render();
  }

  updateCounts() {
    this.totalTests = Array.from(this.iframes.values()).reduce((sum, data) => sum + (data.total > 0 ? data.total : 0), 0);
    this.successTests = Array.from(this.iframes.values()).reduce((sum, data) => sum + data.success, 0);
    this.errorTests = Array.from(this.iframes.values()).reduce((sum, data) => sum + data.error, 0);
    this.render();
  }

  render() {
    const isFinished = this.totalTests > 0 && (this.successTests + this.errorTests) === this.totalTests && this.pendingUrls.length === 0;
    const isSuccess = isFinished && this.errorTests === 0;
    const isFailure = this.errorTests > 0;

    if (isFailure) {
      this.setAttribute('failure', '');
      this.removeAttribute('success');
    } else if (isSuccess) {
      this.setAttribute('success', '');
      this.removeAttribute('failure');
    } else {
      this.removeAttribute('success');
      this.removeAttribute('failure');
    }

    let html = `
      <style>
        :host {
          display: block;
          padding: 12px;
          margin: 8px 0;
          border-radius: 4px;
          font-family: system-ui, -apple-system, sans-serif;
          background: #f8f9fa;
          border-left: 4px solid #6c757d;
        }
        :host([success]) {
          background: #d4edda;
          border-left: 4px solid #28a745;
        }
        :host([failure]) {
          background: #f8d7da;
          border-left: 4px solid #dc3545;
        }
        :host([success]) .header { color: #155724; }
        :host([failure]) .header { color: #721c24; }
        
        .header {
          font-weight: bold;
          margin-bottom: 8px;
          font-size: 1.1em;
        }
        .summary {
          margin-bottom: 12px;
          font-weight: bold;
        }
        .iframe-group {
          margin-top: 16px;
          padding-top: 12px;
          border-top: 1px solid rgba(0,0,0,0.1);
        }
        .iframe-title {
          font-weight: bold;
          margin-bottom: 8px;
          cursor: pointer;
          display: flex;
          align-items: center;
          user-select: none;
          padding: 8px;
          border-radius: 4px;
        }
        .iframe-title.success {
          background: #d4edda;
          color: #155724;
          border-left: 4px solid #28a745;
        }
        .iframe-title.failure {
          background: #f8d7da;
          color: #721c24;
          border-left: 4px solid #dc3545;
        }
        .iframe-title:hover {
          opacity: 0.9;
        }
        .iframe-title .toggle-icon {
          margin-right: 8px;
          font-size: 0.8em;
          transition: transform 0.2s;
          display: inline-block;
        }
        .iframe-title.expanded .toggle-icon {
          transform: rotate(90deg);
        }
        .iframe-content {
          display: none;
        }
        .iframe-content.expanded {
          display: block;
        }
        .result-item {
          margin-top: 8px;
          padding: 8px;
          background: rgba(255, 255, 255, 0.5);
          border-radius: 3px;
          font-size: 0.9em;
        }
        .result-item.success { color: #155724; }
        .result-item.failure { color: #721c24; }
        
        .result-name { font-weight: bold; }
        .result-content, .error-msg, .error-stack {
          margin-top: 4px;
          font-family: monospace;
          white-space: pre-wrap;
        }
        .error-stack {
          background: rgba(0, 0, 0, 0.05);
          padding: 8px;
          overflow-x: auto;
        }
      </style>
      <div class="header">
        Group Test Results
      </div>
      <div class="summary">
        Total: ${this.totalTests} | Success: ${this.successTests} | Error: ${this.errorTests}
      </div>
      <div class="details">
        ${Array.from(this.iframes.entries()).map(([url, data]) => {
          if (data.total === -1 && url !== this.currentUrl) return ''; // 未开始且不在运行中则不显示
          
          const isExpanded = this.expandedGroups.has(url);
          const expandClass = isExpanded ? 'expanded' : '';
          
          const isFinished = data.total !== -1 && data.results.length === data.total;
          let statusClass = '';
          if (isFinished) {
            statusClass = data.error > 0 ? 'failure' : 'success';
          } else if (data.error > 0) {
            statusClass = 'failure'; // 运行中如果有错误提前变红
          } else if (url === this.currentUrl) {
            statusClass = 'running'; // 可选：正在运行的样式
          }
          
          const displayTotal = data.total === -1 ? '?' : data.total;
          
          let groupHtml = `<div class="iframe-group" data-url="${url}">
            <div class="iframe-title ${expandClass} ${statusClass}">
              <span class="toggle-icon">▶</span>
              <span>${new URL(url).pathname} - Total: ${displayTotal}, Success: ${data.success}, Error: ${data.error}</span>
            </div>
            <div class="iframe-content ${expandClass}">`;
            
          data.results.forEach(r => {
            const statusIcon = r.success ? '✓' : '✗';
            groupHtml += `
              <div class="result-item ${r.success ? 'success' : 'failure'}">
                <div class="result-name">${statusIcon} ${this.escapeHtml(r.name)}</div>`;
                
            if (!r.success) {
               if (r.result && typeof r.result === 'object' && r.result.message) {
                 groupHtml += `<div class="error-msg">Error: ${this.escapeHtml(r.result.message)}</div>`;
                 if (r.result.stack) {
                   groupHtml += `<div class="error-stack">${this.escapeHtml(r.result.stack)}</div>`;
                 }
               } else {
                 groupHtml += `<div class="error-msg">Assertion failed: expected true but got ${this.escapeHtml(JSON.stringify(r.result && r.result.assert))}</div>`;
               }
            } else {
               if (r.result && r.result.content) {
                 groupHtml += `<div class="result-content">${this.escapeHtml(JSON.stringify(r.result.content, null, 2))}</div>`;
               }
            }
            
            groupHtml += `</div>`;
          });
          
          groupHtml += `</div></div>`;
          return groupHtml;
        }).join('')}
      </div>
    `;

    let container = this.shadowRoot.querySelector('.ui-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'ui-container';
      
      // 代理点击事件处理折叠/展开
      container.addEventListener('click', (e) => {
        const titleEl = e.target.closest('.iframe-title');
        if (titleEl) {
          const groupEl = titleEl.closest('.iframe-group');
          if (groupEl) {
            const url = groupEl.getAttribute('data-url');
            if (url) {
              this.toggleGroup(url);
            }
          }
        }
      });
      
      this.shadowRoot.appendChild(container);
    }
    container.innerHTML = html;
  }

  escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement("div");
    div.textContent = String(text);
    return div.innerHTML;
  }
}

customElements.define("ok-group-test", OkGroupTest);