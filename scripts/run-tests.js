import { runTests } from 'sibyl-test/scripts/run-tests.js';
import { generateTestHtml } from 'sibyl-test/scripts/generate-test-html.js';
import { createServer } from 'http-server';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const PORT = 30028;

const BROWSER_FILTER = process.env.BROWSER;

const browsers = BROWSER_FILTER
  ? BROWSER_FILTER.split(',').map(b => b.trim())
  : ['webkit', 'chrome', 'firefox'];

async function run() {
  const server = createServer({
    root: rootDir,
    cors: true,
  });

  await new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`Server started at http://localhost:${PORT}`);
      resolve();
    });
  });

  try {
    const result = await runTests({
      browsers,
      port: PORT,
      rootDir,
    });

    server.close();

    if (result.success) {
      console.log('All tests passed!');
      process.exit(0);
    } else {
      console.log('Some tests failed');
      process.exit(1);
    }
  } catch (error) {
    server.close();
    console.error('Error running tests:', error);
    process.exit(1);
  }
}

run();