// 从 GitHub 仓库获取文件
export const getByGh = async ({ path }) => {
  const rePath = path.replace(/^\/_gh\//, "https://cdn.jsdelivr.net/gh/");
  console.log("gh: ", rePath);
  const response = await fetch(rePath);

  // 获取文本内容
  const blob = await response.blob();

  // 转化为新的 Response 对象
  const newResponse = new Response(blob, response);

  return newResponse;
};
