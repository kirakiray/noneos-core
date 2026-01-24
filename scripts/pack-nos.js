import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const nosPath = path.resolve(__dirname, '../nos');
const outputPath = path.resolve(__dirname, '../nos.zip');

const output = fs.createWriteStream(outputPath);
const archive = archiver('zip', {
  zlib: { level: 9 }
});

output.on('close', () => {
  console.log(`已创建 nos.zip，共 ${archive.pointer()} 字节`);
});

archive.on('error', (err) => {
  throw err;
});

archive.directory(nosPath, false, {
  ignore: ['.DS_Store']
});
archive.pipe(output);
await archive.finalize();
