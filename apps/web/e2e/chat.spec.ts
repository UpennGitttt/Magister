import { expect, test } from "@playwright/test";
import { mockAppEnvironment } from "./test-helpers";

test.describe("Chat Page", () => {
  test.beforeEach(async ({ page }) => {
    await mockAppEnvironment(page);
    await page.goto("/chat");
  });

  test("shows chat input and message area", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Sessions", level: 1 })).toBeVisible();
    await expect(page.getByLabel("Chat message")).toBeVisible();
    await expect(page.getByText("Start a new conversation")).toBeVisible();
  });
});
