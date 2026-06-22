import { test, expect } from "@playwright/test";
import { mockAppEnvironment } from "./test-helpers";

/**
 * Touch target size assertion — every clickable element on the
 * mobile viewport must be at least 40×40 CSS pixels.
 */

const SELECTORS = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "[role='button']",
  ".sidebar__nav-link",
  ".dashboard-action-btn",
  ".task-card",
  ".agent-card",
  ".settings-nav__item",
  ".board-column",
  ".app-mobile-bar__menu",
  ".sidebar__close",
  ".chat-page__mobile-bar-btn",
];

async function gotoMobile(page, path = "/") {
  await mockAppEnvironment(page);
  await page.goto(path);
  await page.waitForSelector(".app-mobile-bar", { state: "visible" });
}

async function assertTouchTargets(page, label: string) {
  const failures: string[] = [];
  for (const sel of SELECTORS) {
    const locators = await page.locator(sel).all();
    for (let i = 0; i < locators.length; i++) {
      const el = locators[i];
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      const box = await el.boundingBox().catch(() => null);
      if (!box) continue;
      if (box.width < 40 || box.height < 40) {
        const text = await el.textContent().catch(() => "");
        failures.push(
          `${label} — ${sel}[${i}] ${text.slice(0, 30)}: ${Math.round(box.width)}×${Math.round(box.height)}`,
        );
      }
    }
  }
  if (failures.length) {
    throw new Error(`Touch target failures (${failures.length}):\n${failures.join("\n")}`);
  }
}

test.describe("touch targets", () => {
  test("dashboard page", async ({ page }) => {
    await gotoMobile(page, "/");
    await assertTouchTargets(page, "dashboard");
  });

  test("board page", async ({ page }) => {
    await gotoMobile(page, "/board");
    await assertTouchTargets(page, "board");
  });

  test("settings page", async ({ page }) => {
    await gotoMobile(page, "/settings");
    await assertTouchTargets(page, "settings");
  });

  test("agents page", async ({ page }) => {
    await gotoMobile(page, "/agents");
    await assertTouchTargets(page, "agents");
  });

  test("chat page", async ({ page }) => {
    await gotoMobile(page, "/sessions");
    await assertTouchTargets(page, "chat");
  });
});
