import { firefox } from "playwright";

(async () => {
  const context = await firefox.launchPersistentContext("./user-data", {
    headless: false,
    firefoxUserPrefs: {
      "dom.serviceWorkers.enabled": true,
      "dom.serviceWorkers.testing.enabled": true,
    },
  });

  const page = context.pages()[0] || (await context.newPage());

  await page.goto("http://localhost:3002/_test-all.html");

  console.log("页面已打开:", page.url());

  await page.waitForTimeout(500000);

  await context.close();
})();
