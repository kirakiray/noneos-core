// @ts-check
import { test, expect } from "@playwright/test";

test("should load ofa.js successfully in root directory reference mode", async ({
  page,
  browserName,
}) => {
  // 跳过 firefox测试: sw使用file system 会报错
  test.skip(browserName === 'firefox', 'Skipping Firefox');

  // Navigate to the test page
  await page.goto("/tests/cases/get-ofajs.html");

  // Wait for the page to load and for the module to be imported
  await page.waitForLoadState("networkidle");

  // Wait for a bit to ensure all scripts have executed
  await page.waitForTimeout(3000);

  // Check the result element text content
  const resultElement = await page.$("#result");

  if (!resultElement) {
    throw new Error("resultElement not found");
  }

  const resultText = await resultElement.textContent();

  // Simple assertion: if the result is "failed", immediately fail the test
  // Otherwise, if the result is "success", the test passes
  expect(resultText).toBe("success");
});
