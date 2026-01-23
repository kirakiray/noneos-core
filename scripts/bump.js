import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packagePath = path.join(__dirname, "..", "package.json");
const packageContent = JSON.parse(fs.readFileSync(packagePath, "utf-8"));

const [major, minor, patch] = packageContent.version.split(".").map(Number);
const newVersion = `${major}.${minor}.${patch + 1}`;

const versionPattern = new RegExp(`noneos-core@\\d+\\.\\d+\\.\\d+`, "g");

function replaceVersionInFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  const newContent = content.replace(
    versionPattern,
    `noneos-core@${newVersion}`,
  );
  if (newContent !== content) {
    fs.writeFileSync(filePath, newContent, "utf-8");
    console.log(`Updated: ${filePath}`);
  }
}

function walkDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (!["node_modules", ".git", "dist", "build"].includes(file)) {
        walkDir(fullPath);
      }
    } else if (
      file.endsWith(".js") ||
      file.endsWith(".ts") ||
      file.endsWith(".json")
    ) {
      replaceVersionInFile(fullPath);
    }
  }
}

walkDir(path.join(__dirname, ".."));

packageContent.version = newVersion;
fs.writeFileSync(
  packagePath,
  JSON.stringify(packageContent, null, 2) + "\n",
  "utf-8",
);
console.log(`\nVersion updated to: ${newVersion}`);
