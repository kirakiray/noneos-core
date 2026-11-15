import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// 浏览器默认装到仓库内，避免受 ~/Library/Caches 权限/隔离属性影响。
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(rootDir, '.pw-browsers');
process.env.SE_CACHE_PATH ||= path.join(rootDir, '.selenium-cache');

const { runTests } = await import('sibyl-test/scripts/run-tests.js');

const PORT = Number(process.env.TEST_PORT || 3002);
const TIMEOUT = Number(process.env.TEST_TIMEOUT_MINUTES || 10) * 60 * 1000;
const BROWSER_FILTER = process.env.BROWSER;

// 默认跑 Chrome、WebKit、Firefox；Firefox 走 Selenium，需要本机 Firefox。
// 可用 BROWSER=chrome,webkit 只跑 Playwright 浏览器。
const browsers = BROWSER_FILTER
  ? BROWSER_FILTER.split(',').map((b) => b.trim()).filter(Boolean)
  : ['chrome', 'webkit', 'firefox'];

const result = await runTests({
  browsers,
  port: PORT,
  rootDir,
  timeout: TIMEOUT,
});

if (result.success) {
  console.log('All tests passed!');
  process.exit(0);
}
console.log('Some tests failed');
process.exit(1);
