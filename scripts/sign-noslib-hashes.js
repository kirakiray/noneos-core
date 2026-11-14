// 用根证书 active 密钥签发 nos-lib 文件清单 -> nos-lib/nos-lib.json
import fs from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { loadRootSigner, repoRoot } from "./lib/load-root-signer.js";
import { verifyData } from "../nos/crypto/crypto-verify.js";

const require = createRequire(import.meta.url);
const hashes = require(join(repoRoot, "noslib-hashes.json"));
const manifestPath = join(repoRoot, "nos-lib/nos-lib.json");

let previousVersion = 0;
if (fs.existsSync(manifestPath)) {
  try {
    previousVersion = Number(JSON.parse(fs.readFileSync(manifestPath, "utf8")).version) || 0;
  } catch {
    previousVersion = 0;
  }
}

const { sign, pair } = await loadRootSigner();

const data = {
  version: Math.max(Date.now(), previousVersion + 1),
  publicKey: pair.public,
  signTime: Date.now(),
  hashes,
};

const signature = await sign(JSON.stringify(data));
const finalData = {
  ...data,
  signature: btoa(String.fromCharCode(...new Uint8Array(signature))),
};

if (!(await verifyData(finalData))) {
  throw new Error("nos-lib.json 自校验失败");
}

fs.writeFileSync(manifestPath, JSON.stringify(finalData, null, 2));
console.log(
  `已签发 nos-lib/nos-lib.json：version=${finalData.version}，${hashes.length} 个文件`,
);
