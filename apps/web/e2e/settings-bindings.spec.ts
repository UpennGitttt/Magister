import { expect, test } from "@playwright/test";
import { mockAppEnvironment } from "./test-helpers";

test.describe("Settings Bindings", () => {
  test.beforeEach(async ({ page }) => {
    await mockAppEnvironment(page);
    await page.goto("/settings");
  });

  test("does not expose the legacy bindings tab in the standard settings UI", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Bindings" })).toHaveCount(0);
  });
});
