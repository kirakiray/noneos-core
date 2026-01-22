import { test, expect } from "@playwright/test";

test("zips Test", async ({ page, browserName }) => {
  test.skip(browserName === "firefox", "Skipping Firefox");

  await page.goto("tests/util/zip/zips.ok.html");

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
