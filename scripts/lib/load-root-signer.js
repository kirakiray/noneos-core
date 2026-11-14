// 读取根证书信任集中的 active 密钥并创建签名器（供 nos.json / nos-lib.json 共用）
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { createSigner } from "../../nos/crypto/crypto-ecdsa.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, "../..");

export const loadRootSigner = async () => {
  const rootCert = require(join(repoRoot, "nos/root-cert.json"));
  const activeEntries = rootCert.keys.filter((key) => key.status === "active");
  if (activeEntries.length !== 1) {
    throw new Error(
      `Expected exactly one active key in nos/root-cert.json, got ${activeEntries.length}`,
    );
  }

  const signerEntry = activeEntries[0];
  const keyCandidates = [
    join(repoRoot, `rootkeys/keys/${signerEntry.id}.json`),
    join(repoRoot, `rootkeys/${signerEntry.id}.json`),
    join(repoRoot, "rootkeys/root.json"),
  ];
  const keyPath = keyCandidates.find((candidate) => existsSync(candidate));
  if (!keyPath) {
    throw new Error(`Key file not found for id "${signerEntry.id}"`);
  }
  if (keyPath === join(repoRoot, "rootkeys/root.json") && signerEntry.id !== "root") {
    throw new Error(`Key file not found for id "${signerEntry.id}"`);
  }

  const pair = require(keyPath);
  if (pair.public !== signerEntry.publicKey) {
    throw new Error(
      `Key file "${keyPath}" does not match the active key in root-cert.json`,
    );
  }

  return { signerEntry, pair, sign: await createSigner(pair.private) };
};
