// dev-bridge：开发调试模式下的 HTML 脚本注入
//
// 由 systemConfig.devBridge 配置驱动（nos-config/system.json）：
//   {
//     "devBridge": {
//       "script": "http://127.0.0.1:PORT/client.js",  // 非空才启用注入
//       "async": true,                                 // 缺省 false（同步插入，尽早执行）
//       "banner": true                                 // 缺省 true，页面顶部警告横幅
//     }
//   }
//
// 行为约定：
// - 仅对顶层 HTML 导航（GET + destination === "document"）注入；
// - 响应 content-type 含 text/html 且文档带 <head> 标签才注入，
//   无 <head> 的文档（如 ofa.js 页面/组件模块）直接原样返回；
// - 注入位置为 <head> 开标签之后（head 内最前），顺序为：
//   ① 防篡改警告横幅守卫脚本（同步内联，先于页面所有脚本执行）
//   ② 配置的 dev bridge script
// - 横幅被页面脚本移除/隐藏时，整页替换为「疑似恶意程序」警告；
// - 任何读取/解析失败都原样返回原始响应，绝不因注入失败破坏页面。

// 注入到每个页面的守卫脚本：显示开发模式警告横幅，并被防篡改保护。
// 说明：注入位置在 <head> 最前，本脚本先于页面所有脚本执行，因此闭包内
// 固化的 MutationObserver/setInterval 引用无法被页面脚本替换；防御是
// 尽力而为（best-effort）级别，而非绝对不可绕过。
const BANNER_GUARD_SCRIPT = `
(() => {
  if (self.__noneosDevBanner) return;
  self.__noneosDevBanner = true;

  const Observer = MutationObserver;
  const ticker = setInterval;

  // 多语言文案：跟随浏览器语言（zh* → 中文，其余 → 英文）
  const isZh = (navigator.language || "en").toLowerCase().startsWith("zh");
  const i18n = isZh
    ? {
        banner:
          "⚠️ 开发者模式已启用（dev-bridge）— 页面被注入调试脚本，请勿输入敏感数据",
        alarm:
          "⚠️ 警告：此页面移除了开发者模式横幅，疑似恶意程序，请立即停止操作并关闭本页。",
      }
    : {
        banner:
          "⚠️ Developer mode enabled (dev-bridge) — debug scripts are injected into this page. Do not enter sensitive data.",
        alarm:
          "⚠️ WARNING: this page removed the developer-mode banner and may be malicious. Stop what you are doing and close this page.",
      };

  const BANNER_ID = "__noneos-dev-banner";
  const ALARM_ID = "__noneos-dev-alarm";
  const POS_KEY = "__noneos-dev-banner-pos";
  const MAX_Z = "2147483647";

  // 恢复上次拖拽保存的位置（跨页面、跨会话记忆）
  const restorePos = (el) => {
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
        el.style.left = Math.max(0, Math.min(saved.left, innerWidth - 40)) + "px";
        el.style.top = Math.max(0, Math.min(saved.top, innerHeight - 20)) + "px";
        el.style.right = "auto";
      }
    } catch {}
  };

  // 拖拽支持：横幅可被拖到不遮挡关键内容的位置，位置持久化到 localStorage
  const makeDraggable = (el) => {
    if (el.__noneosDraggable) return;
    el.__noneosDraggable = true;
    el.style.cursor = "move";
    el.style.userSelect = "none";
    el.style.touchAction = "none";

    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    const onMove = (e) => {
      const left = Math.max(
        0,
        Math.min(startLeft + e.clientX - startX, innerWidth - 40)
      );
      const top = Math.max(
        0,
        Math.min(startTop + e.clientY - startY, innerHeight - 20)
      );
      el.style.left = left + "px";
      el.style.top = top + "px";
      el.style.right = "auto";
    };

    const onEnd = () => {
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerup", onEnd);
      try {
        localStorage.setItem(
          POS_KEY,
          JSON.stringify({ left: el.offsetLeft, top: el.offsetTop })
        );
      } catch {}
    };

    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = el.offsetLeft;
      startTop = el.offsetTop;
      addEventListener("pointermove", onMove);
      addEventListener("pointerup", onEnd);
    });
  };

  const createBanner = () => {
    const el = document.createElement("div");
    el.id = BANNER_ID;
    el.textContent = i18n.banner;
    Object.assign(el.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      zIndex: MAX_Z,
      padding: "6px 12px",
      textAlign: "center",
      fontWeight: "600",
      fontSize: "13px",
      lineHeight: "1.5",
      color: "#6b4300",
      background: "rgba(255, 193, 7, 0.8)",
    });
    makeDraggable(el);
    restorePos(el);
    return el;
  };

  const getBanner = () => document.getElementById(BANNER_ID);

  const ensureBanner = () => {
    let el = getBanner();
    if (!el) {
      el = createBanner();
      (document.documentElement || document).appendChild(el);
    }
    return el;
  };

  const isBannerVisible = () => {
    const el = getBanner();
    if (!el || !el.isConnected) return false;
    const style = self.getComputedStyle(el);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      parseFloat(style.opacity || "1") > 0.05
    );
  };

  let alarmed = false;
  const createAlarm = () => {
    const el = document.createElement("div");
    el.id = ALARM_ID;
    el.textContent = i18n.alarm;
    Object.assign(el.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
      padding: "40px",
      fontWeight: "700",
      fontSize: "18px",
      color: "#fff",
      background: "rgba(176, 0, 32, 0.97)",
    });
    return el;
  };

  const alarm = () => {
    if (alarmed) return;
    alarmed = true;
    try {
      self.console.warn("[dev-bridge] banner tampering detected, page replaced with warning");
    } catch {}
    // 整页替换为警告（后续由 observer/interval 持续恢复）
    document.documentElement.style.overflow = "hidden";
    while (document.body && document.body.firstChild) {
      document.body.firstChild.remove();
    }
    document.body.appendChild(createAlarm());
  };

  // 绝对置顶保障：重申最大 z-index，并保持为 documentElement 的最后一个
  // 子元素（相同 z-index 时，DOM 靠后者在视觉上层级更高）
  const keepOnTop = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.zIndex = MAX_Z;
    const root = document.documentElement;
    if (root.lastElementChild !== el) {
      root.appendChild(el);
    }
  };

  const check = () => {
    if (alarmed) {
      // 警告页同样被防篡改保护：被移除就恢复，且保持绝对置顶
      keepOnTop(ALARM_ID);
      if (!document.getElementById(ALARM_ID)) {
        document.body && document.body.appendChild(createAlarm());
      }
      return;
    }
    if (!isBannerVisible()) {
      // 文档解析期间横幅可能尚未就绪，先补挂；
      // 解析完成后横幅仍不可见，判定为页面脚本篡改，整页告警
      if (document.readyState === "loading") {
        ensureBanner();
      } else {
        alarm();
      }
      return;
    }
    keepOnTop(BANNER_ID);
  };

  ensureBanner();
  new Observer(check).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  ticker(check, 1000);
})();
`;

// 判断当前请求是否需要启用 dev-bridge 拦截
export const isDevBridgeRequest = (request, systemConfig) => {
  const { script } = systemConfig?.devBridge || {};
  return (
    !!script &&
    request.method === "GET" &&
    request.destination === "document"
  );
};

// 包装 event.respondWith：所有经 SW 处理的导航响应统一过一遍注入
export const wrapDevBridgeRespond = (event, systemConfig) => {
  const originalRespondWith = event.respondWith.bind(event);
  let responded = false;
  event.respondWith = (promise) => {
    responded = true;
    originalRespondWith(
      Promise.resolve(promise).then((response) =>
        injectDevBridgeScript(response, systemConfig),
      ),
    );
  };
  // 返回探针函数：分支逻辑执行完后可据此判断是否已被响应
  return () => responded;
};

// 对 text/html 响应注入 dev bridge script；不满足条件时原样返回
export const injectDevBridgeScript = async (response, systemConfig) => {
  const { script, async: asyncAttr, banner = true } =
    systemConfig?.devBridge || {};

  if (!script || !response) {
    return response;
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    return response;
  }

  try {
    const html = await response.text();
    const headers = new Headers(response.headers);
    headers.delete("content-length");

    const headTag = html.match(/<head[^>]*>/i);
    if (!headTag) {
      // 无 <head>，按约定不注入；body 已被读取，需用原文重建响应
      return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    // 拼接注入 payload：横幅守卫脚本在前（含转义，避免 </script> 提前闭合），bridge script 在后
    const guardTag = banner
      ? `<script>${BANNER_GUARD_SCRIPT.replace(/<\/script/gi, "<\\/script")}</script>`
      : "";
    const attrs = asyncAttr ? " async" : "";
    const tag = guardTag + `<script src="${script}"${attrs}></script>`;
    const injected = html.replace(headTag[0], () => headTag[0] + tag);

    return new Response(injected, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    // 读取或改写失败时回退原始响应
    return response;
  }
};
