import { get, init } from "/nos/fs/handle/main.js";

export const install = async () => {
  // 查看在线 nos.json 文件
  const nosJSON = await fetch("./nos.json").then((res) => res.json());

  // TODO: 验证json是否正确

  // 获取本地 nos.json 文件配置
  await init("nos-config");
  const baseConfigHandle = await get("nos-config/base.json", {
    create: "file",
  });

  const nosData = nosJSON.data;

  // 写入 nos.json 文件配置
  await baseConfigHandle.write(
    JSON.stringify({
      version: nosData.version,
    }),
  );
};
