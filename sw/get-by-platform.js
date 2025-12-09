// 从 GitHub 仓库获取文件
export const getByGh = async ({ path }) => {
  const rePath = path.replace(/^\/\$gh\//, "https://cdn.jsdelivr.net/gh/");
  console.log("gh: ", rePath);
  const response = await fetch(rePath);

  // 获取文本内容
  const text = await response.text();

  // 转化为新的 Response 对象
  const newResponse = new Response(text, response);

  return newResponse;
};
