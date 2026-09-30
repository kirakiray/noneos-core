// 打包 nos/ → nos.tgz（USTAR tar + gzip）。
// 确定性构建：tar 头 mtime/uid/gid/mode 固定（见 scripts/lib/tar.js）、
// gzip mtime=0、固定压缩级别与文件排序，同输入产出字节级一致的包。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { createTar } from './lib/tar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nosPath = path.resolve(__dirname, '../nos');
const outputPath = path.resolve(__dirname, '../nos.tgz');

const files = [];
const walk = (dir, base = '') => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(full, rel);
    } else {
      files.push({ path: rel, data: fs.readFileSync(full) });
    }
  }
};
walk(nosPath);

// 路径字节序排序，保证包内条目顺序跨机器一致
files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const tar = createTar(files);
const tgz = zlib.gzipSync(tar, { level: 9, mtime: 0 });

fs.writeFileSync(outputPath, tgz);
console.log(
  `已创建 nos.tgz，共 ${tgz.length} 字节（${files.length} 个文件，tar ${tar.length} 字节）`,
);
