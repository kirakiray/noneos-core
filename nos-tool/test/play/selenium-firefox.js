import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

(async () => {
  const options = new firefox.Options();

  const driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .build();

  try {
    await driver.get("http://localhost:3002/_test-all.html");

    console.log("页面已打开:", await driver.getCurrentUrl());

    await driver.sleep(500000);
  } finally {
    await driver.quit();
  }
})();
