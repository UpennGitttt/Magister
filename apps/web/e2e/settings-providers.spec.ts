import { expect, test } from "@playwright/test";
import { mockAppEnvironment } from "./test-helpers";

test.describe("Settings Providers", () => {
  test.beforeEach(async ({ page }) => {
    await mockAppEnvironment(page);
    await page.goto("/settings");
  });

  test("opens provider edit form and cancels", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Providers" })).toBeVisible();

    const editButton = page.getByRole("button", { name: "Edit" }).first();
    await expect(editButton).toBeVisible();
    await editButton.click();

    await expect(page.getByLabel("Label")).toBeVisible();
    await expect(page.getByLabel("Base URL")).toBeVisible();
    await expect(page.getByLabel(/Secret Ref/i)).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).first().click();
    await expect(page.getByRole("form", { name: /Edit/i })).toHaveCount(0);
  });
});
