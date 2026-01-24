import { verifyData } from "../nos/crypto/crypto-verify.js";

export const getOnlineData = async () => {
  // 获取根证书，并生成验证器
  const rootCert = await fetch(
    import.meta.resolve("../nos/root-cert.json"),
  ).then((e) => e.json());

  const isRootCertValid = await verifyData(rootCert);

  if (!isRootCertValid) {
    throw new Error("Root certificate verification failed");
  }

  // 查看在线 nos.json 文件
  const onlineNosConfig = await fetch(import.meta.resolve("../nos.json")).then(
    (res) => res.json(),
  );

  // 验证 nos.json 中的 hashes 是否被擅改
  const isNosJsonValid = await verifyData(onlineNosConfig);

  if (!isNosJsonValid) {
    throw new Error("nos.json verification failed");
  }

  return {
    rootCert,
    onlineNosConfig,
  };
};
