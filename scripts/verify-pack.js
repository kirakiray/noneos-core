// 校验 nos.zip 与 nos.json 的一致性（构建期护栏）：
// - 清单声明的每个路径必须存在于 zip 内，且 hash（与安装器同一套分块哈希算法）
//   和 size 完全一致
// - zip 内不允许出现清单未声明的文件
// 背景：hash 清单与 zip 必须同一次构建产生；改了 nos/ 只重算 hash 不重打包
// 会导致客户端安装校验失败（首页卡在 Install NoneOS Core），本脚本让这类
// 漂移在构建期当场暴露。
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getFileHash } from '../nos/util/hash/get-file-hash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const manifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'nos.json'), 'utf-8')
);
const declaredPaths = new Set(manifest.hashes.map((h) => h.path));

const tmpDir = fs.mkdtempSync(path.join(repoRoot, '.verify-pack-'));
const errors = [];
try {
  execSync(`unzip -oq nos.zip -d "${tmpDir}"`, { cwd: repoRoot });

  const zipFiles = [];
  const walk = (dir, base = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue; // pack-nos.js 同样忽略
      const full = path.join(dir, entry.name);
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else {
        zipFiles.push({ rel, full });
      }
    }
  };
  walk(tmpDir);

  for (const { path: p, hash, size } of manifest.hashes) {
    const file = zipFiles.find((f) => f.rel === p);
    if (!file) {
      errors.push(`zip 内缺失清单声明的文件: ${p}`);
      continue;
    }
    const bytes = fs.readFileSync(file.full);
    const actualHash = await getFileHash(bytes);
    if (actualHash !== hash) {
      errors.push(
        `hash 不一致: ${p} (nos.json: ${hash.slice(0, 8)}..., zip: ${actualHash.slice(0, 8)}...)`
      );
    }
    if (bytes.length !== size) {
      errors.push(`size 不一致: ${p} (nos.json: ${size}, zip: ${bytes.length})`);
    }
  }

  for (const { rel } of zipFiles) {
    if (!declaredPaths.has(rel)) {
      errors.push(`zip 内存在清单未声明的文件: ${rel}`);
    }
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (errors.length > 0) {
  console.error(
    `verify-pack failed：nos.zip 与 nos.json 不一致 (version ${manifest.version})`
  );
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  console.error('提示：改了 nos/ 后必须重跑 npm run build:hashes（会重打包并校验）');
  process.exit(1);
}

console.log(
  `verify-pack ok：nos.zip 与 nos.json 一致 (version ${manifest.version}，${manifest.hashes.length} 个文件)`
);
