import { test, expect } from "@playwright/test";
import { mockAppEnvironment } from "./test-helpers";

/**
 * Mobile navigation E2E — validates the hamburger + drawer pattern
 * on iPhone 14 / Pixel 7 viewports.
 */

async function gotoMobile(page) {
  await mockAppEnvironment(page);
  await page.goto("/");
  await expect(page.locator(".app-mobile-bar")).toBeVisible();
}

test.describe("mobile nav drawer", () => {
  test("hamburger button is visible and 44×44", async ({ page }) => {
    await gotoMobile(page);
    const menu = page.locator(".app-mobile-bar__menu");
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test("clicking hamburger opens sidebar drawer", async ({ page }) => {
    await gotoMobile(page);
    await page.locator(".app-mobile-bar__menu").click();
    const drawer = page.locator(".sidebar");
    await expect(drawer).toHaveAttribute("data-mobile-open", "true");
    await expect(drawer).toHaveAttribute("role", "dialog");
    await expect(drawer).toHaveAttribute("aria-modal", "true");
  });

  test("backdrop is visible when drawer open", async ({ page }) => {
    await gotoMobile(page);
    await page.locator(".app-mobile-bar__menu").click();
    await expect(page.locator(".app-sidebar-backdrop")).toBeVisible();
  });

  test("clicking backdrop closes drawer", async ({ page }) => {
    await gotoMobile(page);
    await page.locator(".app-mobile-bar__menu").click();
    await page.locator(".app-sidebar-backdrop").click();
    await expect(page.locator(".sidebar")).toHaveAttribute("data-mobile-open", "false");
  });

  test("Escape key closes drawer", async ({ page }) => {
    await gotoMobile(page);
    await page.locator(".app-mobile-bar__menu").click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".sidebar")).toHaveAttribute("data-mobile-open", "false");
  });

  test("close button inside drawer is 44×44", async ({ page }) => {
    await gotoMobile(page);
    await page.locator(".app-mobile-bar__menu").click();
    const close = page.locator(".sidebar__close");
    await expect(close).toBeVisible();
    const box = await close.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test("navigating via drawer closes it", async ({ page }) => {
    await gotoMobile(page);
    await page.locator(".app-mobile-bar__menu").click();
    // Click the first nav link
    const firstLink = page.locator(".sidebar__item").first();
    await firstLink.click();
    await expect(page.locator(".sidebar")).toHaveAttribute("data-mobile-open", "false");
  });

  test("page title is shown in mobile bar", async ({ page }) => {
    await gotoMobile(page);
    const title = page.locator(".app-mobile-bar__title");
    await expect(title).toBeVisible();
    await expect(title).not.toHaveText("");
  });
});
