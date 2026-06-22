import { test, expect, type Page } from "@playwright/test";
import { mockAppEnvironment } from "./test-helpers";

/**
 * iOS focus zoom prevention — every <input> and <textarea> must have
 * a computed font-size of at least 16px on the mobile viewport.
 */

type ZoomCase = {
  name: string;
  path: string;
  prepare?: (page: Page) => Promise<void>;
};

const CASES: ZoomCase[] = [
  { name: "dashboard", path: "/" },
  { name: "board", path: "/board" },
  { name: "settings provider form", path: "/settings", prepare: async (page) => {
    await page.getByRole("button", { name: "+ New provider" }).click();
  } },
  { name: "settings agent form", path: "/agents", prepare: async (page) => {
    await page.getByRole("button", { name: "+ New agent" }).click();
  } },
  { name: "sessions composer and drawer search", path: "/sessions", prepare: async (page) => {
    await page.locator(".chat-page__mobile-bar-btn").first().click();
    await expect(page.locator(".chat-page__sessions-panel")).toHaveAttribute("data-mobile-open", "true");
  } },
];

async function assertInputZoom(page, testCase: ZoomCase) {
  await mockAppEnvironment(page);
  await page.goto(testCase.path);
  await page.waitForSelector(".app-mobile-bar", { state: "visible" });
  await testCase.prepare?.(page);

  const inputs = await page.locator("input:not([type='hidden']):not([type='checkbox']):not([type='radio'])").all();
  const textareas = await page.locator("textarea").all();
  const selects = await page.locator("select").all();
  const all = [...inputs, ...textareas, ...selects];

  const failures: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;
    const fontSize = await el.evaluate((node: HTMLElement) => {
      const computed = window.getComputedStyle(node);
      return parseFloat(computed.fontSize);
    });
    if (fontSize < 16) {
      const tag = await el.evaluate((node: HTMLElement) => node.tagName);
      const name = await el.getAttribute("name") || "";
      const id = await el.getAttribute("id") || "";
      failures.push(`${testCase.name} — ${tag}${id ? `#${id}` : ""}${name ? `[name=${name}]` : ""}: ${fontSize}px`);
    }
  }

  if (failures.length) {
    throw new Error(`Input zoom failures (${failures.length}):\n${failures.join("\n")}`);
  }
}

test.describe("input zoom prevention", () => {
  for (const testCase of CASES) {
    test(testCase.name, async ({ page }) => {
      await assertInputZoom(page, testCase);
    });
  }
});
