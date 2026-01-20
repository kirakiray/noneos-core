import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

function calculateFileHash(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}

function getFileSize(filePath) {
  const stats = fs.statSync(filePath);
  return stats.size;
}

function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);

  files.forEach(file => {
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

const nosDir = 'nos';
const outputFilePath = 'hashes.json';

console.log('Scanning files in nos directory...');
const allFiles = getAllFiles(nosDir);

console.log(`Found ${allFiles.length} files. Calculating hashes...`);

const results = allFiles.map(filePath => {
  console.log(`Processing: ${filePath}`);
  const hash = calculateFileHash(filePath);
  const size = getFileSize(filePath);
  const relativePath = path.relative(nosDir, filePath);

  return {
    path: relativePath,
    hash: hash,
    size: size
  };
});

console.log('Writing results to hashes.json...');
fs.writeFileSync(outputFilePath, JSON.stringify(results, null, 2));

console.log(`Done! Processed ${results.length} files.`);
console.log(`Results saved to: ${outputFilePath}`);
