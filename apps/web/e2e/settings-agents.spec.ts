import { expect, test } from "@playwright/test";
import { mockAppEnvironment } from "./test-helpers";

test.describe("Settings Agents", () => {
  test.beforeEach(async ({ page }) => {
    await mockAppEnvironment(page);
    await page.goto("/settings");
  });

  test("renders built-in agent cards and opens then cancels create form", async ({ page }) => {
    await page.getByRole("button", { name: "Agents" }).click();

    await expect(page.getByText(/roleId: coder/i)).toBeVisible();
    await expect(page.getByText(/roleId: reviewer/i)).toBeVisible();
    await expect(page.getByText(/roleId: architect/i)).toBeVisible();
    await expect(page.getByText(/roleId: lander/i)).toBeVisible();

    const builtInBadges = page.getByText("Built-in");
    expect(await builtInBadges.count()).toBeGreaterThanOrEqual(4);

    await page.getByRole("button", { name: "New Agent" }).click();
    await expect(page.getByRole("form", { name: "Create agent profile" })).toBeVisible();

    await page.getByLabel("Role ID").fill("qa");
    await page.getByLabel("Label").fill("QA Agent");

    await page.getByRole("button", { name: "Cancel" }).first().click();
    await expect(page.getByRole("form", { name: "Create agent profile" })).toHaveCount(0);
  });
});
