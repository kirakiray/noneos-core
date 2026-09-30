// 系统包解压与下载压缩，全部基于浏览器原生压缩 API（Compression Streams），
// 零第三方依赖、零网络依赖：
// - unzip：DecompressionStream('gzip') 解流 + USTAR tar 解析，用于安装器解包 nos.tgz
// - zip：手写 ZIP 容器 + CompressionStream('deflate-raw')，用于目录下载产物（真实
//   zip 格式，可被操作系统直接打开）；不写入任何时间戳

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

export async function unzip(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error("unsupported archive: expected gzip (tar.gz)");
  }

  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const tarBuffer = await new Response(stream).arrayBuffer();

  const view = new DataView(tarBuffer);
  const files = [];

  let offset = 0;
  while (offset + 512 <= tarBuffer.byteLength) {
    // 结束零块即停止
    let isZeroBlock = true;
    for (let i = 0; i < 512; i++) {
      if (view.getUint8(offset + i) !== 0) {
        isZeroBlock = false;
        break;
      }
    }
    if (isZeroBlock) break;

    // 校验和：计算时 checksum 字段（148-156）本身按 8 个空格计
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum +=
        i >= 148 && i < 156 ? 0x20 : view.getUint8(offset + i);
    }
    const declared = parseInt(
      UTF8_DECODER.decode(new Uint8Array(tarBuffer, offset + 148, 8)).replace(
        /\0|\s/g,
        "",
      ),
      8,
    );
    if (checksum !== declared) {
      throw new Error(`tar header checksum mismatch at offset ${offset}`);
    }

    const size = parseInt(
      UTF8_DECODER.decode(new Uint8Array(tarBuffer, offset + 124, 12)).replace(
        /\0|\s/g,
        "",
      ),
      8,
    );
    const typeflag = String.fromCharCode(view.getUint8(offset + 156));
    const name = UTF8_DECODER.decode(
      new Uint8Array(tarBuffer, offset, 100),
    ).replace(/\0[\s\S]*$/, "");
    const prefix = UTF8_DECODER.decode(
      new Uint8Array(tarBuffer, offset + 345, 155),
    ).replace(/\0[\s\S]*$/, "");
    const path = prefix ? `${prefix}/${name}` : name;

    const data = new Uint8Array(tarBuffer, offset + 512, size);
    offset += 512 + size + ((512 - (size % 512)) % 512);

    // 目录条目（typeflag '5' 或以 / 结尾）跳过
    if ((typeflag === "0" || typeflag === "\0") && !path.endsWith("/")) {
      files.push({
        path,
        file: new File([data], path.split("/").pop()),
      });
    }
  }

  return files;
}

// ---------- ZIP 容器写路径（目录下载用） ----------

let CRC_TABLE;
const crc32 = (bytes) => {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      CRC_TABLE[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const deflateRaw = async (bytes) => {
  const stream = new Blob([bytes]).stream().pipeThrough(
    new CompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

export const zip = async (files) => {
  if (!files.length) return null;

  if (files.length > 0xffff) {
    throw new Error("too many files for zip (max 65535)");
  }

  const chunks = [];
  const centralEntries = [];
  let offset = 0;
  const push = (bytes) => {
    chunks.push(bytes);
    offset += bytes.length;
  };

  for (const { file, path: entryPath } of files) {
    const raw = new Uint8Array(await file.arrayBuffer());
    const deflated = await deflateRaw(raw);
    const nameBytes = UTF8_ENCODER.encode(entryPath);
    const crc = crc32(raw);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true); // version needed: 2.0
    localView.setUint16(6, 0x0800, true); // flags: UTF-8 文件名
    localView.setUint16(8, 8, true); // method: deflate
    // 10/12：修改时间与日期，固定 0（不写入时间戳）
    localView.setUint32(14, crc, true);
    localView.setUint32(18, deflated.length, true);
    localView.setUint32(22, raw.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const entryOffset = offset; // 中央目录须记录本地头的起始偏移
    push(local);
    push(deflated);

    centralEntries.push({ nameBytes, crc, compSize: deflated.length, size: raw.length, offset: entryOffset });
  }

  const centralStart = offset;
  for (const entry of centralEntries) {
    const central = new Uint8Array(46 + entry.nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, 0x0800, true); // flags: UTF-8 文件名
    centralView.setUint16(10, 8, true); // method: deflate
    // 12/14：修改时间与日期，固定 0（不写入时间戳）
    centralView.setUint32(16, entry.crc, true);
    centralView.setUint32(20, entry.compSize, true);
    centralView.setUint32(24, entry.size, true);
    centralView.setUint16(28, entry.nameBytes.length, true);
    centralView.setUint32(42, entry.offset, true);
    central.set(entry.nameBytes, 46);
    push(central);
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, centralEntries.length, true);
  eocdView.setUint16(10, centralEntries.length, true);
  eocdView.setUint32(12, offset - centralStart, true);
  eocdView.setUint32(16, centralStart, true);
  push(eocd);

  if (offset > 0xffffffff) {
    throw new Error("archive too large for zip (no Zip64 support)");
  }

  return new Blob(chunks, { type: "application/zip" });
};
