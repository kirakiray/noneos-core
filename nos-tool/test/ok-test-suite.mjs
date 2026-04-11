const templatePromise = (async () => {
  const baseUrl = import.meta.url;
  const templateUrl = new URL('./ok-test-suite-template.html', baseUrl).href;
  const response = await fetch(templateUrl);
  return response.text();
})();

export default class OkTestSuite extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.totalTests = 0;
    this.successTests = 0;
    this.errorTests = 0;
    this.iframes = new Map();
    this.expandedGroups = new Set();
    this.pendingUrls = [];
    this.currentUrl = null;
    this.templateReady = false;
    
    this.handleMessage = this.handleMessage.bind(this);
    this.toggleGroup = this.toggleGroup.bind(this);
  }

  async connectedCallback() {
    window.addEventListener("message", this.handleMessage);

    const includes = this.querySelectorAll("include");
    this.pendingUrls = Array.from(includes).map(inc => inc.getAttribute("src")).filter(Boolean).map(url => new URL(url, window.location.href).toString());

    this.templateHtml = await templatePromise;
    this.templateReady = true;
    
    this.render();
    this.runNextIframe();
  }

  runNextIframe() {
    if (this.pendingUrls.length === 0) return;
    
    const absoluteUrl = this.pendingUrls.shift();
    this.currentUrl = absoluteUrl;
    
    const iframe = document.createElement("iframe");
    iframe.src = absoluteUrl;
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "none";
    iframe.style.position = "absolute";
    iframe.style.visibility = "hidden";
    this.shadowRoot.appendChild(iframe);

    this.iframes.set(absoluteUrl, {
      iframe,
      total: -1,
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
    if (!this.templateReady) return;

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

    const details = this.renderDetails();
    let html = this.templateHtml
      .replace('{{totalTests}}', this.totalTests)
      .replace('{{successTests}}', this.successTests)
      .replace('{{errorTests}}', this.errorTests)
      .replace('{{details}}', details);

    let container = this.shadowRoot.querySelector('.ui-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'ui-container';
      
      container.addEventListener('click', (e) => {
        const openBtn = e.target.closest('.open-btn');
        if (openBtn) {
          const url = openBtn.getAttribute('data-open-url');
          if (url) {
            window.open(url, '_blank');
          }
          return;
        }
        
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

  renderDetails() {
    return Array.from(this.iframes.entries()).map(([url, data]) => {
      if (data.total === -1 && url !== this.currentUrl) return '';
      
      const isExpanded = this.expandedGroups.has(url);
      const expandClass = isExpanded ? 'expanded' : '';
      
      const isFinished = data.total !== -1 && data.results.length === data.total;
      let statusClass = '';
      if (isFinished) {
        statusClass = data.error > 0 ? 'failure' : 'success';
      } else if (data.error > 0) {
        statusClass = 'failure';
      } else if (url === this.currentUrl) {
        statusClass = 'running';
      }
      
      const displayTotal = data.total === -1 ? '?' : data.total;
      
      let groupHtml = `<div class="iframe-group" data-url="${url}">
        <div class="iframe-title ${expandClass} ${statusClass}">
          <span class="toggle-icon">▶</span>
          <span>${new URL(url).pathname} - Total: ${displayTotal}, Success: ${data.success}, Error: ${data.error}</span>
          <span class="open-btn" data-open-url="${url}">Open</span>
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
    }).join('');
  }

  escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement("div");
    div.textContent = String(text);
    return div.innerHTML;
  }
}

customElements.define("ok-test-suite", OkTestSuite);
