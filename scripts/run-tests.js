import { webkit } from "playwright";
import { createServer } from "http-server";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

const PORT = 30028;
const TEST_URL = `http://localhost:${PORT}/_test-all.html`;
const WEBKIT_DATA_DIR = path.join(rootDir, ".webkit-test-data");

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deleteDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
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

  let context;
  try {
    context = await webkit.launchPersistentContext(WEBKIT_DATA_DIR, {
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
      process.exit(1);
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
      console.log("\n✓ Tests Passed!");
      console.log(`  Total: ${stats.total}`);
      console.log(`  Success: ${stats.success}`);
      console.log(`  Error: ${stats.error}`);
    } else {
      console.log("\n✗ Tests Failed!");
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
      process.exit(1);
    }

    await context.close();
  } catch (error) {
    console.error("Error running tests:", error);
    if (context) {
      await context.close();
    }
    process.exit(1);
  } finally {
    server.close();
    deleteDir(WEBKIT_DATA_DIR);
  }
}

runTests();
