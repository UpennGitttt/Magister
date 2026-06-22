import { expect, test } from "@playwright/test";
import { mockAppEnvironment } from "./test-helpers";

test.describe("Settings Models", () => {
  test.beforeEach(async ({ page }) => {
    await mockAppEnvironment(page);
    await page.goto("/settings");
  });

  test("shows model cards with readiness badge", async ({ page }) => {
    await page.getByRole("button", { name: "Models" }).click();

    await expect(page.getByRole("button", { name: "Edit" }).first()).toBeVisible();
    await expect(page.getByText(/Ready|Needs Setup/).first()).toBeVisible();
  });
});
