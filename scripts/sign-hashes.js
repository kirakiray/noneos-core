import { createRequire } from "node:module";
import fs from "node:fs";
import { join } from "node:path";

import { loadRootSigner, repoRoot } from "./lib/load-root-signer.js";

const require = createRequire(import.meta.url);
const hashes = require(join(repoRoot, "hashes.json"));
const packageJSON = require(join(repoRoot, "package.json"));

const { sign, pair } = await loadRootSigner();

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

fs.writeFileSync(join(repoRoot, "nos.json"), JSON.stringify(finalData, null, 2));
