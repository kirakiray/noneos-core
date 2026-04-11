import { webkit } from "playwright";

(async () => {
  const context = await webkit.launchPersistentContext("./webkit-user-data", {
    headless: false,
  });

  const page = context.pages()[0] || (await context.newPage());

  await page.goto(
    "http://localhost:3002/tests/fs/handle/write-and-get.ok.html",
  );

  console.log("页面已打开:", page.url());

  await page.waitForTimeout(5000);

  await context.close();
})();
