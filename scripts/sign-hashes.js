import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

import { createSigner } from "../nos/crypto/crypto-ecdsa.js";

const hashes = require("../hashes.json");
const pair = require("../rootkeys/root.json");
const packageJSON = require("../package.json");

const sign = await createSigner(pair.private);

const data = {
  version: packageJSON.version,
  publicKey: pair.public,
  signTime: Date.now(),
  hashes,
};

const signature = await sign(JSON.stringify(data));

const finalData = {
  data,
  signature: btoa(String.fromCharCode(...new Uint8Array(signature))),
};

// 写入到 nos.json 中
require("fs").writeFileSync("nos.json", JSON.stringify(finalData, null, 2));
