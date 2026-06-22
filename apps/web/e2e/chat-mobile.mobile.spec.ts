import { test, expect } from "@playwright/test";
import { mockAppEnvironment } from "./test-helpers";

/**
 * Chat page mobile-specific E2E — validates sessions drawer + trace
 * bottom-sheet behavior on the mobile viewport.
 */

async function gotoChat(page) {
  await mockAppEnvironment(page);
  await page.goto("/w/workspace_main/sessions");
  await page.waitForSelector(".chat-page__mobile-bar", { state: "visible" });
}

test.describe("chat mobile", () => {
  test("chat mobile bar is visible", async ({ page }) => {
    await gotoChat(page);
    await expect(page.locator(".chat-page__mobile-bar")).toBeVisible();
  });

  test("sessions drawer opens via hamburger", async ({ page }) => {
    await gotoChat(page);
    await page.locator(".chat-page__mobile-bar-btn").first().click();
    await expect(page.locator(".chat-page__sessions-panel")).toHaveAttribute("data-mobile-open", "true");
  });

  test("session details bottom sheet opens via info button", async ({ page }) => {
    await mockAppEnvironment(page);
    await page.goto("/w/workspace_main/sessions/task-1");
    await page.waitForSelector(".chat-page__mobile-bar", { state: "visible" });
    await page.getByLabel("Show session details").click();
    await expect(page.locator(".chat-page__mobile-context-sheet")).toHaveAttribute("data-mobile-open", "true");
  });

  test("chat input is visible and reachable", async ({ page }) => {
    await gotoChat(page);
    const input = page.locator(".chat-input-bar__field");
    await expect(input).toBeVisible();
    // iOS zoom prevention
    const fontSize = await input.evaluate((node: HTMLElement) => {
      return parseFloat(window.getComputedStyle(node).fontSize);
    });
    expect(fontSize).toBeGreaterThanOrEqual(16);
  });

  test("safe-area padding is present on input bar", async ({ page }) => {
    await gotoChat(page);
    const bar = page.locator(".chat-input-bar");
    await expect(bar).toBeVisible();
    const padding = await bar.evaluate((node: HTMLElement) => {
      return window.getComputedStyle(node).paddingBottom;
    });
    // Should contain env() or at least some padding
    expect(padding).not.toBe("0px");
  });

  test("empty chat composer does not take over the first screen", async ({ page }) => {
    await gotoChat(page);

    const metrics = await page.evaluate(() => {
      const bar = document.querySelector(".chat-input-bar");
      const shell = document.querySelector(".chat-input-bar__shell");
      return {
        barHeight: bar?.getBoundingClientRect().height ?? 0,
        shellHeight: shell?.getBoundingClientRect().height ?? 0,
      };
    });

    expect(metrics.barHeight).toBeLessThanOrEqual(150);
    expect(metrics.shellHeight).toBeLessThanOrEqual(140);
  });

  test("expanded chat composer stays below one third of the viewport", async ({ page }) => {
    await gotoChat(page);

    const field = page.locator(".chat-input-bar__field");
    await expect(field).toBeVisible();
    await field.fill(Array.from({ length: 32 }, (_, i) => `Line ${i + 1}: keep the composer compact.`).join("\n"));

    const metrics = await page.evaluate(() => {
      const bar = document.querySelector(".chat-input-bar");
      const field = document.querySelector(".chat-input-bar__field");
      return {
        barHeight: bar?.getBoundingClientRect().height ?? 0,
        fieldHeight: field?.getBoundingClientRect().height ?? 0,
        viewportHeight: window.innerHeight,
      };
    });

    expect(metrics.fieldHeight).toBeLessThanOrEqual(metrics.viewportHeight * 0.34);
    expect(metrics.barHeight).toBeLessThanOrEqual(metrics.viewportHeight * 0.4);
  });
});
