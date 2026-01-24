import fs from 'fs';
import path from 'path';
import { getFileHash } from '../nos/util/hash/get-file-hash.js';

function getFileSize(filePath) {
  const stats = fs.statSync(filePath);
  return stats.size;
}

function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);

  files.forEach(file => {
    if (file === '.DS_Store') return;

    const fullPath = path.join(dirPath, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
    } else {
      arrayOfFiles.push(fullPath);
    }
  });

  return arrayOfFiles;
}

async function main() {
  const nosDir = 'nos';
  const outputFilePath = 'hashes.json';

  console.log('Scanning files in nos directory...');
  const allFiles = getAllFiles(nosDir);

  console.log(`Found ${allFiles.length} files. Calculating hashes...`);

  const results = [];
  for (const filePath of allFiles) {
    console.log(`Processing: ${filePath}`);
    const fileBuffer = fs.readFileSync(filePath);
    const hash = await getFileHash(fileBuffer);
    const size = getFileSize(filePath);
    const relativePath = path.relative(nosDir, filePath);

    results.push({
      path: relativePath,
      hash: hash,
      size: size
    });
  }

  console.log('Writing results to hashes.json...');
  fs.writeFileSync(outputFilePath, JSON.stringify(results, null, 2));

  console.log(`Done! Processed ${results.length} files.`);
  console.log(`Results saved to: ${outputFilePath}`);
}

main().catch(console.error);
