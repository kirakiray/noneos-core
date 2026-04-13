import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

function findSbHtmlFiles(dir, baseDir) {
  const results = [];
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      if (file !== "node_modules" && file !== ".git") {
        results.push(...findSbHtmlFiles(fullPath, baseDir));
      }
    } else if (file.endsWith(".sb.html")) {
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
    <script type="module" src="https://cdn.jsdelivr.net/gh/ofajs/sibyl-test/components/sb-test-suite.mjs"></script>
  </head>
  <body>
    <sb-test-suite>
${includeTags}
    </sb-test-suite>
  </body>
</html>
`;

  fs.writeFileSync(outputPath, html, "utf-8");
}

const sbHtmlFiles = findSbHtmlFiles(rootDir, rootDir);
const outputFilePath = path.join(rootDir, "_test-all.html");

generateAllHtml(sbHtmlFiles, outputFilePath);

console.log(`Found ${sbHtmlFiles.length} .sb.html files`);
console.log(`Generated: ${outputFilePath}`);
