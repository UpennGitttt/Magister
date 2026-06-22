import { expect, test } from "@playwright/test";
import { createConsoleErrorTracker, mockAppEnvironment } from "./test-helpers";

test.describe("Sidebar Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await mockAppEnvironment(page);
    await page.goto("/");
  });

  test("loads each sidebar destination without console errors", async ({ page }) => {
    const tracker = createConsoleErrorTracker(page);
    await page.goto("/");

    const links = ["Control Center", "Board", "Sessions", "Agents", "Skills", "Settings"];
    for (const label of links) {
      await expect(page.getByRole("link", { name: label })).toBeVisible();
    }

    let checkpoint = tracker.checkpoint();
    await expect(page.getByRole("heading", { name: "Control Center", level: 1 })).toBeVisible();
    tracker.expectNoNewErrors(checkpoint, "Control Center");

    const destinations = [
      { nav: "Board", assertion: () => page.getByRole("heading", { name: "Work Board", level: 1 }) },
      { nav: "Sessions", assertion: () => page.getByRole("heading", { name: "Sessions", level: 1 }) },
      { nav: "Agents", assertion: () => page.getByRole("heading", { name: "Settings", level: 1 }) },
      { nav: "Skills", assertion: () => page.getByRole("heading", { name: "Settings", level: 1 }) },
      {
        nav: "Settings",
        assertion: () => page.getByRole("heading", { name: "Settings", level: 1 }),
      },
      {
        nav: "Control Center",
        assertion: () => page.getByRole("heading", { name: "Control Center", level: 1 }),
      },
    ];

    for (const destination of destinations) {
      checkpoint = tracker.checkpoint();
      await page.getByRole("link", { name: destination.nav }).click();
      await expect(destination.assertion()).toBeVisible();
      tracker.expectNoNewErrors(checkpoint, destination.nav);
    }
  });
});
