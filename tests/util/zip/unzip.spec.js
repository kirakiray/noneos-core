import { test, expect } from "@playwright/test";

test("unzip Test", async ({ page }) => {
  await page.goto("tests/util/zip/unzip.ok.html");

  const count = 4;

  await page.getByTestId("test-completion-notification").click();

  const testCases = await page.$$("test-case");

  expect(await testCases.length).toBe(count);

  let id = 0;
  for (const testCase of testCases) {
    id++;
    const successMark = await testCase.$(".success");
    expect(successMark, `测试用例 #${id} 执行失败`).not.toBeNull();
  }
});
