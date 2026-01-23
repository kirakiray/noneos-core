export const handleNosToolRequest = async ({ path, request, systemConfig }) => {
  if (location.host === "localhost:3002") {
    // 在本地的开发环境，直接返回请求结果
    return fetch(request);
  }

  // 从本地端口调试，替换为请求 3002
  if (/^localhost:/.test(location.host)) {
    // 替换请求 URL 中的端口为 3002
    const newUrl = request.url.replace(/:(\d+)/, ":3002");
    return fetch(newUrl);
  }
};
