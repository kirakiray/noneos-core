import { ZipArchive } from 'archiver';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const skillName = process.argv[2];
if (!skillName) {
  console.error('请指定 skill 名称，例如: node scripts/build-skill.js noneos-core-docs');
  process.exit(1);
}

const skillDir = path.resolve(__dirname, `../.agents/skills/${skillName}`);
const outputPath = path.resolve(__dirname, `../.agents/skills/${skillName}.zip`);

if (!fs.existsSync(skillDir)) {
  console.error(`skill 目录不存在: ${skillDir}`);
  process.exit(1);
}

// 把仓库版本号同步到 SKILL.md 顶部 frontmatter 的 version 字段（幂等）
const repoVersion = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'),
).version;
const skillMdPath = path.join(skillDir, 'SKILL.md');
const skillMd = fs.readFileSync(skillMdPath, 'utf-8');
const frontmatterMatch = skillMd.match(/^---\n([\s\S]*?)\n---/);
if (!frontmatterMatch) {
  console.error('SKILL.md 缺少 frontmatter，无法写入 version');
  process.exit(1);
}
let frontmatter = frontmatterMatch[1];
if (/^version:/m.test(frontmatter)) {
  frontmatter = frontmatter.replace(/^version:.*$/m, `version: "${repoVersion}"`);
} else {
  frontmatter += `\nversion: "${repoVersion}"`;
}
fs.writeFileSync(
  skillMdPath,
  `---\n${frontmatter}\n---${skillMd.slice(frontmatterMatch[0].length)}`,
);
console.log(`已同步 version: ${repoVersion} 到 ${skillName}/SKILL.md`);

const output = fs.createWriteStream(outputPath);
const archive = new ZipArchive({
  zlib: { level: 9 }
});

output.on('close', () => {
  console.log(`已创建 ${skillName}.zip，共 ${archive.pointer()} 字节`);
});

archive.on('error', (err) => {
  throw err;
});

archive.directory(skillDir, false, {
  ignore: ['.DS_Store']
});
archive.pipe(output);
await archive.finalize();
