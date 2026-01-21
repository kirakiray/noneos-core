import { get, init } from "/nos/fs/handle/main.js";
import { verifyData } from "/nos/crypto/crypto-verify.js";

export const install = async () => {
  // 获取根证书，并生成验证器
  const rootCert = await fetch("/nos/root-cert.json").then((e) => e.json());
  const result1 = await verifyData(rootCert);

  if (!result1) {
    throw new Error("Root certificate verification failed");
  }

  // 查看在线 nos.json 文件
  const nosJSON = await fetch("./nos.json").then((res) => res.json());

  // 验证nos.json 中的 hashes 是否被擅改
  const result2 = await verifyData(nosJSON);

  if (!result2) {
    throw new Error("nos.json verification failed");
  }

  // 获取本地 nos.json 文件配置
  await init("nos-config");
  const baseConfigHandle = await get("nos-config/system.json", {
    create: "file",
  });

  // 写入 nos.json 文件配置
  await baseConfigHandle.write(
    JSON.stringify({
      version: nosJSON.version,
      mode: "online", // online: 从在线获取nos模块文件；local: 从本地获取nos模块文件
      nosMapPath: "nos", // nos 映射路径
    }),
  );
};
