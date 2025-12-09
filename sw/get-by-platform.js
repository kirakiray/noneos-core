// 从 GitHub 仓库获取文件
export const getByGh = async ({ path }) => {
  const rePath = path.replace(/^\/\$gh\//, "https://cdn.jsdelivr.net/gh/");
  console.log("gh: ", rePath);
  return fetch(rePath);
};
