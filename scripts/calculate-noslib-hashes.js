// 计算 nos-lib/ 的逐文件 SHA-256（整文件哈希，与 SW 端 crypto.subtle.digest 一致）
// 产出临时 noslib-hashes.json，随后由 sign-noslib-hashes.js 签名生成 nos-lib/nos-lib.json
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, join } from "node:path";
import { shouldIncludeInPack } from "./lib/pack-filter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const nosLibDir = resolve(__dirname, "../nos-lib");
const outputPath = resolve(__dirname, "../noslib-hashes.json");
const MANIFEST_NAME = "nos-lib.json";

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name !== MANIFEST_NAME) {
      files.push(full);
    }
  }
};
walk(nosLibDir);

files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const hashes = files
  .map((file) => relative(nosLibDir, file).split(path.sep).join("/"))
  .filter(shouldIncludeInPack)
  .map((relPath) => {
    const file = join(nosLibDir, relPath);
    const data = fs.readFileSync(file);
    return {
      path: relPath,
      hash: crypto.createHash("sha256").update(data).digest("hex"),
      size: data.length,
    };
  });

fs.writeFileSync(outputPath, JSON.stringify(hashes, null, 2));
console.log(`已计算 nos-lib 哈希：${hashes.length} 个文件 -> noslib-hashes.json`);
