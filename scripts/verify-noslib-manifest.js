// 校验 nos-lib/nos-lib.json：签名有效性、签名者是否 active、文件清单是否与磁盘一致
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, join } from "node:path";

import { verifyData } from "../nos/crypto/crypto-verify.js";
import { shouldIncludeInPack } from "./lib/pack-filter.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const nosLibDir = join(repoRoot, "nos-lib");
const manifestPath = join(nosLibDir, "nos-lib.json");
const MANIFEST_NAME = "nos-lib.json";

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const rootCert = require(join(repoRoot, "nos/root-cert.json"));
const activeKeys = rootCert.keys
  .filter((key) => key.status === "active")
  .map((key) => key.publicKey);

const errors = [];

if (!activeKeys.includes(manifest.publicKey)) {
  errors.push("manifest is not signed by an active root key");
}
if (!(await verifyData(manifest))) {
  errors.push("manifest signature verification failed");
}
if (!Number.isFinite(Number(manifest.version))) {
  errors.push("manifest version is not a number");
}

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name !== MANIFEST_NAME) {
      const relPath = relative(nosLibDir, full).split(path.sep).join("/");
      if (shouldIncludeInPack(relPath)) files.push(full);
    }
  }
};
walk(nosLibDir);

const listed = new Map(manifest.hashes.map((item) => [item.path, item]));
for (const file of files) {
  const relPath = relative(nosLibDir, file).split(path.sep).join("/");
  const item = listed.get(relPath);
  if (!item) {
    errors.push(`file not in manifest: ${relPath}`);
    continue;
  }
  const data = fs.readFileSync(file);
  const hash = crypto.createHash("sha256").update(data).digest("hex");
  if (hash !== item.hash || data.length !== item.size) {
    errors.push(`hash/size mismatch: ${relPath}`);
  }
  listed.delete(relPath);
}
for (const leftover of listed.keys()) {
  errors.push(`manifest entry has no file: ${leftover}`);
}

if (errors.length > 0) {
  console.error("nos-lib manifest verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`verify-noslib ok：version=${manifest.version}，${files.length} 个文件`);
