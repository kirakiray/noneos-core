// 签名包/哈希清单的收录规则：纯文档（*.md）与组件测试（*.sb.html）不参与运行时，
// 不进入 nos.tgz / nos.json / nos-lib.json，减少安装体积与校验面。
export const shouldIncludeInPack = (relativePath) => {
  const normalized = String(relativePath).replace(/\\/g, "/");
  return !/(^|\/)(?:[^/]+\.md|[^/]+\.sb\.html)$/i.test(normalized);
};
