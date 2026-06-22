import { test, expect, type Page } from "@playwright/test";
import { mockAppEnvironment } from "./test-helpers";

const CASES = [
  { name: "settings", path: "/settings" },
  { name: "sessions", path: "/sessions" },
];

async function gotoMobile(page: Page, path: string) {
  await mockAppEnvironment(page);
  await page.goto(path);
  await page.waitForSelector(".app-mobile-bar", { state: "visible" });
}

test.describe("mobile page overflow", () => {
  for (const testCase of CASES) {
    test(`${testCase.name} does not expose page-level horizontal panning`, async ({ page }) => {
      await gotoMobile(page, testCase.path);

      const metrics = await page.evaluate(() => {
        const main = document.querySelector(".app-main");
        const mainStyle = main ? window.getComputedStyle(main) : null;
        return {
          documentClientWidth: document.documentElement.clientWidth,
          documentScrollWidth: document.scrollingElement?.scrollWidth ?? document.documentElement.scrollWidth,
          bodyClientWidth: document.body.clientWidth,
          bodyScrollWidth: document.body.scrollWidth,
          mainOverflowX: mainStyle?.overflowX ?? "",
        };
      });

      expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.documentClientWidth);
      expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth);
      expect(["hidden", "clip"]).toContain(metrics.mainOverflowX);
    });
  }
});
