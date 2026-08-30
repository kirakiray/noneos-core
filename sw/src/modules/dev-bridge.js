// dev-bridge：开发调试模式下的 HTML 脚本注入
//
// 由 systemConfig.devBridge 配置驱动（nos-config/system.json）：
//   {
//     "devBridge": {
//       "script": "http://127.0.0.1:PORT/client.js",  // 非空才启用注入
//       "async": true                                   // 缺省 false（同步插入，尽早执行）
//     }
//   }
//
// 行为约定：
// - 仅对顶层 HTML 导航（GET + destination === "document"）注入；
// - 响应 content-type 含 text/html 且文档带 <head> 标签才注入，
//   无 <head> 的文档（如 ofa.js 页面/组件模块）直接原样返回；
// - 注入位置为 <head> 开标签之后（head 内最前）；
// - 任何读取/解析失败都原样返回原始响应，绝不因注入失败破坏页面。

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
  const { script, async: asyncAttr } = systemConfig?.devBridge || {};

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

    const attrs = asyncAttr ? " async" : "";
    const tag = `<script src="${script}"${attrs}></script>`;
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
