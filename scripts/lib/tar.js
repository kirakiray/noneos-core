// 最小 USTAR tar 读写工具（供 pack-nos.js 与 verify-pack.js 共用）。
// 设计约束：tar 头的 mtime/uid/gid/mode 全部写固定值，保证同输入产出字节级一致的包；
// 仅处理普通文件条目（typeflag '0'），目录不落条目。
import path from 'path';

const BLOCK = 512;

const pad = (num, len) => num.toString(8).padStart(len - 1, '0') + '\0';

const writeHeader = (header, { name, prefix, size }) => {
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'utf8'); // mode 固定 0644
  header.write('0000000\0', 108, 8, 'utf8'); // uid 固定 0
  header.write('0000000\0', 116, 8, 'utf8'); // gid 固定 0
  header.write(pad(size, 12), 124, 12, 'utf8');
  header.write('00000000000\0', 136, 12, 'utf8'); // mtime 固定 0（无时间戳）
  header.write('        ', 148, 8, 'utf8'); // checksum 占位（8 空格）
  header.write('0', 156, 1, 'utf8'); // typeflag: 普通文件
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');
  header.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
};

// USTAR 路径拆分：name(100) + prefix(155)，总路径超长时直接报错
const splitName = (relPath) => {
  if (relPath.length <= 100) {
    return { name: relPath, prefix: '' };
  }
  const dir = path.dirname(relPath);
  const base = path.basename(relPath);
  if (dir.length <= 155 && base.length <= 100) {
    return { name: base, prefix: dir };
  }
  throw new Error(`tar path too long: ${relPath}`);
};

// files: [{ path, data: Buffer }] → tar Buffer
export const createTar = (files) => {
  const blocks = [];
  for (const { path: relPath, data } of files) {
    const header = Buffer.alloc(BLOCK);
    writeHeader(header, { ...splitName(relPath), size: data.length });
    blocks.push(header, data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding) {
      blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(BLOCK * 2)); // 结束双零块
  return Buffer.concat(blocks);
};

// tar Buffer → [{ path, data: Buffer }]（仅普通文件条目）
export const parseTar = (buffer) => {
  const files = [];
  let offset = 0;

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);

    // 结束零块
    if (header.every((byte) => byte === 0)) break;

    // 校验和：计算时 checksum 字段本身按 8 个空格计
    let checksum = 0;
    for (let i = 0; i < BLOCK; i++) {
      checksum += i >= 148 && i < 156 ? 0x20 : header[i];
    }
    const declared = parseInt(
      header.toString('utf8', 148, 156).replace(/\0|\s/g, ''),
      8,
    );
    if (checksum !== declared) {
      throw new Error(`tar header checksum mismatch at offset ${offset}`);
    }

    const size = parseInt(
      header.toString('utf8', 124, 136).replace(/\0|\s/g, ''),
      8,
    );
    const typeflag = header.toString('utf8', 156, 157);
    const name = header.toString('utf8', 0, 100).replace(/\0[\s\S]*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0[\s\S]*$/, '');
    const relPath = prefix ? `${prefix}/${name}` : name;

    offset += BLOCK;
    const data = buffer.subarray(offset, offset + size);
    offset += size + ((BLOCK - (size % BLOCK)) % BLOCK);

    if (typeflag === '0' || typeflag === '\0') {
      // Buffer.from 复制一份，避免子数组长期挂在整个包 buffer 上
      files.push({ path: relPath, data: Buffer.from(data) });
    }
  }

  return files;
};
