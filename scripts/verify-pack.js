// 校验 nos.tgz 与 nos.json 的一致性（构建期护栏）：
// - 清单声明的每个路径必须存在于包内，且 hash（与安装器同一套分块哈希算法）
//   和 size 完全一致
// - 包内不允许出现清单未声明的文件
// 背景：hash 清单与系统包必须同一次构建产生；改了 nos/ 只重算 hash 不重打包
// 会导致客户端安装校验失败（首页卡在 Install NoneOS Core），本脚本让这类
// 漂移在构建期当场暴露。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { getFileHash } from '../nos/util/hash/get-file-hash.js';
import { parseTar } from './lib/tar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const manifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'nos.json'), 'utf-8')
);
const declaredPaths = new Set(manifest.hashes.map((h) => h.path));

const errors = [];
const tgz = fs.readFileSync(path.join(repoRoot, 'nos.tgz'));
const entries = parseTar(zlib.gunzipSync(tgz));
const entryByPath = new Map(entries.map((e) => [e.path, e]));

for (const { path: p, hash, size } of manifest.hashes) {
  const entry = entryByPath.get(p);
  if (!entry) {
    errors.push(`包内缺失清单声明的文件: ${p}`);
    continue;
  }
  const actualHash = await getFileHash(entry.data);
  if (actualHash !== hash) {
    errors.push(
      `hash 不一致: ${p} (nos.json: ${hash.slice(0, 8)}..., 包内: ${actualHash.slice(0, 8)}...)`
    );
  }
  if (entry.data.length !== size) {
    errors.push(`size 不一致: ${p} (nos.json: ${size}, 包内: ${entry.data.length})`);
  }
}

for (const { path: p } of entries) {
  if (!declaredPaths.has(p)) {
    errors.push(`包内存在清单未声明的文件: ${p}`);
  }
}

if (errors.length > 0) {
  console.error(
    `verify-pack failed：nos.tgz 与 nos.json 不一致 (version ${manifest.version})`
  );
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  console.error('提示：改了 nos/ 后必须重跑 npm run build:hashes（会重打包并校验）');
  process.exit(1);
}

console.log(
  `verify-pack ok：nos.tgz 与 nos.json 一致 (version ${manifest.version}，${manifest.hashes.length} 个文件)`
);
