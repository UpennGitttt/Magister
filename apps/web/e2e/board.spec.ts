import { expect, test } from "@playwright/test";
import { mockAppEnvironment } from "./test-helpers";

test.describe("Board Page", () => {
  test.beforeEach(async ({ page }) => {
    await mockAppEnvironment(page);
    await page.goto("/board");
  });

  test("renders kanban columns or empty-state content", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Work Board", level: 1 })).toBeVisible();

    await expect(page.getByText("Queued")).toBeVisible();
    await expect(page.getByText("In Progress")).toBeVisible();
    await expect(page.getByText("In Review")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Completed", level: 2 })).toBeVisible();
    await expect(page.getByText("Sample Task")).toBeVisible();
    await expect(page.getByText("No tasks").first()).toBeVisible();
  });
});
