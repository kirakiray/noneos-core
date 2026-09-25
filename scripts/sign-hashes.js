import { createRequire } from "node:module";
import { existsSync } from "node:fs";
const require = createRequire(import.meta.url);

import { createSigner } from "../nos/crypto/crypto-ecdsa.js";

const hashes = require("../hashes.json");
const packageJSON = require("../package.json");

// nos.json 必须由根证书信任集中 active 状态的密钥签发（客户端会校验这一点）
const rootCert = require("../nos/root-cert.json");
const activeEntries = rootCert.keys.filter((key) => key.status === "active");
if (activeEntries.length !== 1) {
  throw new Error(
    `Expected exactly one active key in nos/root-cert.json, got ${activeEntries.length}`
  );
}
const signerEntry = activeEntries[0];
const keyCandidates = [
  `../rootkeys/keys/${signerEntry.id}.json`,
  `../rootkeys/${signerEntry.id}.json`,
  "../rootkeys/root.json",
];
const keyPath = keyCandidates.find((path) => existsSync(new URL(path, import.meta.url)));
if (!keyPath) {
  throw new Error(`Key file not found for id "${signerEntry.id}"`);
}
if (keyPath === "../rootkeys/root.json" && signerEntry.id !== "root") {
  throw new Error(`Key file not found for id "${signerEntry.id}"`);
}
const pair = require(keyPath);
if (pair.public !== signerEntry.publicKey) {
  throw new Error(`Key file "${keyPath}" does not match the active key in root-cert.json`);
}

const sign = await createSigner(pair.private);

const data = {
  version: packageJSON.version,
  publicKey: pair.public,
  signTime: Date.now(),
  hashes,
};

const signature = await sign(JSON.stringify(data));

const finalData = {
  ...data,
  signature: btoa(String.fromCharCode(...new Uint8Array(signature))),
};

// 写入到 nos.json 中
require("fs").writeFileSync("nos.json", JSON.stringify(finalData, null, 2));
