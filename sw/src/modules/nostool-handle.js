export const handleNosToolRequest = async ({ request }) => {
  const host = location.host;

  if (host === "localhost:3002") {
    return fetch(request);
  }

  // 返回官方的地址
  const returnOfficial = () => {
    const afterHost = request.url.replace(/^https?:\/\/[^\/]+\//, "");
    return fetch(`https://core.noneos.com/${afterHost}`);
  };

  if (/^localhost:/.test(host)) {
    const newUrl = request.url.replace(/:(\d+)/, ":3002");
    try {
      return await fetch(newUrl);
    } catch {
      return returnOfficial();
    }
  }

  return returnOfficial();
};
