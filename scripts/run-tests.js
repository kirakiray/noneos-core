import { webkit, chromium, firefox } from "playwright";
import { createServer } from "http-server";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

const PORT = 30028;
const TEST_URL = `http://localhost:${PORT}/_test-all.html`;

const browsers = [
  { name: "webkit", launcher: webkit },
  { name: "chrome", launcher: chromium },
  { name: "firefox", launcher: firefox },
];

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deleteDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

async function runBrowserTests(browserConfig) {
  const { name, launcher } = browserConfig;
  const dataDir = path.join(rootDir, `.${name}-test-data`);

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Running tests with ${name.toUpperCase()}`);
  console.log(`${"=".repeat(50)}\n`);

  let context;
  try {
    context = await launcher.launchPersistentContext(dataDir, {
      headless: true,
    });

    const page = context.pages()[0] || (await context.newPage());

    console.log(`Opening: ${TEST_URL}`);
    await page.goto(TEST_URL);

    console.log("Waiting for tests to complete...");

    let result = null;
    const maxWaitTime = 5 * 60 * 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const testSuite = await page.$("ok-test-suite");
      if (testSuite) {
        const hasSuccess = await testSuite.getAttribute("success");
        const hasFailure = await testSuite.getAttribute("failure");

        if (hasSuccess !== null) {
          result = "passed";
          break;
        }
        if (hasFailure !== null) {
          result = "failed";
          break;
        }
      }
      await sleep(500);
    }

    if (!result) {
      console.log("Timeout: Tests did not complete within 5 minutes");
      return { success: false, name };
    }

    const stats = await page.evaluate(() => {
      const suite = document.querySelector("ok-test-suite");
      if (!suite) return null;

      const total = suite.totalTests || 0;
      const success = suite.successTests || 0;
      const error = suite.errorTests || 0;

      const failedTests = [];
      const groups = suite.shadowRoot.querySelectorAll(".iframe-group");
      groups.forEach((group) => {
        const url = group.getAttribute("data-url");
        const failureItems = group.querySelectorAll(".result-item.failure");
        failureItems.forEach((item) => {
          const nameEl = item.querySelector(".result-name");
          const errorMsgEl = item.querySelector(".error-msg");
          const errorStackEl = item.querySelector(".error-stack");

          failedTests.push({
            url: url,
            name: nameEl ? nameEl.textContent.trim() : "Unknown",
            message: errorMsgEl ? errorMsgEl.textContent.trim() : "",
            stack: errorStackEl ? errorStackEl.textContent.trim() : "",
          });
        });
      });

      return { total, success, error, failedTests };
    });

    if (result === "passed") {
      console.log(`\n✓ ${name.toUpperCase()} Tests Passed!`);
      console.log(`  Total: ${stats.total}`);
      console.log(`  Success: ${stats.success}`);
      console.log(`  Error: ${stats.error}`);
      return { success: true, name, stats };
    } else {
      console.log(`\n✗ ${name.toUpperCase()} Tests Failed!`);
      console.log(`  Total: ${stats.total}`);
      console.log(`  Success: ${stats.success}`);
      console.log(`  Error: ${stats.error}`);
      console.log("\nFailed tests:");
      stats.failedTests.forEach((test, index) => {
        console.log(`\n${index + 1}. ${test.url}`);
        console.log(`   Name: ${test.name}`);
        if (test.message) {
          console.log(`   Error: ${test.message}`);
        }
        if (test.stack) {
          console.log(`   Stack:\n${test.stack}`);
        }
      });
      return { success: false, name, stats };
    }
  } catch (error) {
    console.error(`Error running ${name} tests:`, error);
    return { success: false, name, error };
  } finally {
    if (context) {
      await context.close();
    }
    deleteDir(dataDir);
  }
}

async function runTests() {
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

  const results = [];

  try {
    for (const browserConfig of browsers) {
      const result = await runBrowserTests(browserConfig);
      results.push(result);
    }

    console.log(`\n${"=".repeat(50)}`);
    console.log("Summary");
    console.log(`${"=".repeat(50)}\n`);

    let allPassed = true;
    for (const result of results) {
      const status = result.success ? "✓ PASSED" : "✗ FAILED";
      console.log(`${result.name.toUpperCase()}: ${status}`);
      if (!result.success) {
        allPassed = false;
      }
    }

    if (!allPassed) {
      process.exit(1);
    }
  } finally {
    server.close();
  }
}

runTests();
