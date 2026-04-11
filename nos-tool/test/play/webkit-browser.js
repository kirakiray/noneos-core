import { webkit } from "playwright";

(async () => {
  const browser = await webkit.launch({
    headless: false,
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("http://localhost:3002/tests/fs/handle/write-and-get.ok.html");

  console.log("页面已打开:", page.url());

  await page.waitForTimeout(5000);

  await browser.close();
})();
