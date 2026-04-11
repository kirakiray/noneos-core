import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

function findOkHtmlFiles(dir, baseDir) {
  const results = [];
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      if (file !== "node_modules" && file !== ".git") {
        results.push(...findOkHtmlFiles(fullPath, baseDir));
      }
    } else if (file.endsWith(".ok.html")) {
      const relativePath = path.relative(baseDir, fullPath);
      results.push(relativePath);
    }
  }

  return results;
}

function generateAllHtml(files, outputPath) {
  const includeTags = files
    .map((file) => `      <include src="./${file}"></include>`)
    .sort()
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>All Tests</title>
    <script type="module" src="/nos-tool/test/ok-test-suite.mjs"></script>
  </head>
  <body>
    <ok-test-suite>
${includeTags}
    </ok-test-suite>
  </body>
</html>
`;

  fs.writeFileSync(outputPath, html, "utf-8");
}

const okHtmlFiles = findOkHtmlFiles(rootDir, rootDir);
const outputFilePath = path.join(rootDir, "_test-all.html");

generateAllHtml(okHtmlFiles, outputFilePath);

console.log(`Found ${okHtmlFiles.length} .ok.html files`);
console.log(`Generated: ${outputFilePath}`);
