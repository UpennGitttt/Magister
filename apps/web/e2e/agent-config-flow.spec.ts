import { test, expect } from "@playwright/test";

// This test runs against the LIVE server (not mocked)
// It verifies the actual agent configuration flow works end-to-end

test.describe("Agent Configuration Flow", () => {
  let originalLeaderProfile: Record<string, unknown> | null = null;

  test.skip(
    process.env.MAGISTER_E2E_LIVE !== "1",
    "Requires a live API on :3000 and web app on :4173; standard test:e2e uses mocked browser flows.",
  );

  test.beforeEach(async ({ page }) => {
    // Set auth cookie to bypass login
    await page.context().addCookies([
      {
        name: "magister_auth",
        value: "ok",
        domain: "localhost",
        path: "/",
      },
    ]);
    const response = await page.request.get("http://localhost:3000/settings/agents/leader");
    const payload = await response.json().catch(() => null) as { ok?: boolean; data?: Record<string, unknown> } | null;
    originalLeaderProfile = payload?.ok && payload.data ? payload.data : null;
  });

  test.afterEach(async ({ page }) => {
    if (!originalLeaderProfile) return;
    await page.request.put("http://localhost:3000/settings/agents/leader", {
      data: {
        label: originalLeaderProfile.label,
        description: originalLeaderProfile.description,
        modelName: originalLeaderProfile.modelName,
        modelOverride: originalLeaderProfile.modelOverride,
        providerId: originalLeaderProfile.providerId,
        provider: originalLeaderProfile.provider,
        runtimeType: originalLeaderProfile.runtimeType,
        reasoningMode: originalLeaderProfile.reasoningMode,
        reasoningEffort: originalLeaderProfile.reasoningEffort,
        contextWindow: originalLeaderProfile.contextWindow,
        maxOutputTokens: originalLeaderProfile.maxOutputTokens,
        fallbackModelName: originalLeaderProfile.fallbackModelName,
        fallbackProviderId: originalLeaderProfile.fallbackProviderId,
        maxTurns: originalLeaderProfile.maxTurns,
        toolProfile: originalLeaderProfile.toolProfile,
        omitSkills: originalLeaderProfile.omitSkills,
      },
    });
    originalLeaderProfile = null;
  });

  test("Settings > Agents page loads and shows agents", async ({ page }) => {
    await page.goto("http://localhost:4173/settings");

    // Click Agents tab
    const agentsTab = page.getByRole("button", { name: /agents/i });
    if (await agentsTab.isVisible()) {
      await agentsTab.click();
    }

    // Wait for agent cards to load
    await page.waitForTimeout(2000);

    // Should see at least leader agent
    const content = await page.textContent("body");
    expect(content).toContain("leader");
  });

  test("Edit agent - runtime type change updates command path", async ({
    page,
  }) => {
    await page.goto("http://localhost:4173/settings");

    // Navigate to Agents tab
    const agentsTab = page.getByRole("button", { name: /agents/i });
    if (await agentsTab.isVisible()) {
      await agentsTab.click();
    }
    await page.waitForTimeout(2000);

    // Find and click Edit on coder agent
    const coderCard = page.locator("article").filter({ hasText: "coder" });
    const editBtn = coderCard.getByRole("button", { name: /edit/i });
    if (await editBtn.isVisible()) {
      await editBtn.click();
    }
    await page.waitForTimeout(500);

    // Take a screenshot of the edit form
    await page.screenshot({
      path: "/tmp/agent-edit-form.png",
      fullPage: true,
    });

    // Check if runtime type dropdown exists
    const runtimeSelect = coderCard.locator("select").first();
    if (await runtimeSelect.isVisible()) {
      const currentValue = await runtimeSelect.inputValue();
      console.log("Current runtime type:", currentValue);

      // Change to opencode
      await runtimeSelect.selectOption("opencode");
      await page.waitForTimeout(500);

      // Check command path was auto-filled
      const commandInput = coderCard.locator(
        'input[placeholder*="command"], input[value*="/usr/bin/"]',
      );
      if (await commandInput.isVisible()) {
        const commandValue = await commandInput.inputValue();
        console.log("Command path after switch:", commandValue);
        expect(commandValue).toContain("opencode");
      }

      // Take screenshot after runtime change
      await page.screenshot({
        path: "/tmp/agent-after-runtime-change.png",
        fullPage: true,
      });
    }
  });

  test("Model discovery returns models for each runtime", async ({ page }) => {
    // Test API directly
    const codexModels = await page.request.get(
      "http://localhost:3000/settings/agents/coder/models",
    );
    const codexData = await codexModels.json();
    console.log(
      "Coder models:",
      codexData.data?.models?.length ?? 0,
      "supported:",
      codexData.data?.supported,
    );
    expect(codexData.ok).toBe(true);
    expect(codexData.data.models.length).toBeGreaterThan(0);

    const leaderModels = await page.request.get(
      "http://localhost:3000/settings/agents/leader/models",
    );
    const leaderData = await leaderModels.json();
    console.log(
      "Leader models:",
      leaderData.data?.models?.length ?? 0,
      "supported:",
      leaderData.data?.supported,
    );
    expect(leaderData.ok).toBe(true);
  });

  test("Save agent with valid model succeeds", async ({ page }) => {
    // Save leader with correct model via API
    const response = await page.request.put(
      "http://localhost:3000/settings/agents/leader",
      {
        data: {
          modelName: "kimi-k2.6-ark",
          providerId: "volcengine-ark",
          runtimeType: "ucm",
          label: "Leader",
        },
      },
    );
    const data = await response.json();
    console.log("Save result:", data.ok, data.error?.message ?? "");
    expect(data.ok).toBe(true);
    expect(data.data.modelName).toBe("kimi-k2.6-ark");
  });

  test("Task creation and basic chat works", async ({ page }) => {
    // Create a task via API
    const createResponse = await page.request.post(
      "http://localhost:3000/tasks",
      {
        data: {
          prompt: "说你好",
          source: "web",
          workspaceId: "workspace_main",
        },
      },
    );
    const createData = await createResponse.json();
    console.log("Task created:", createData.data?.taskId, createData.data?.status);
    expect(createData.ok).toBe(true);

    const taskId = createData.data.taskId;

    // Wait for task to complete (poll every 2s, max 30s)
    let taskState = "queued";
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(2000);
      const statusResponse = await page.request.get(
        `http://localhost:3000/tasks/${taskId}`,
      );
      const statusData = await statusResponse.json();
      taskState = statusData.data?.state ?? "unknown";
      console.log(`  Poll ${i + 1}: state=${taskState}`);
      if (taskState === "DONE" || taskState === "FAILED") break;
    }

    console.log("Final state:", taskState);

    // Check events for error details if failed
    if (taskState === "FAILED") {
      const eventsResponse = await page.request.get(
        `http://localhost:3000/tasks/${taskId}/events`,
      );
      const eventsData = await eventsResponse.json();
      const lastEvents = eventsData.data?.events?.slice(-3) ?? [];
      for (const e of lastEvents) {
        console.log(`  [${e.seq}] ${e.type}: ${(e.payloadJson ?? "").slice(0, 200)}`);
      }
    }

    expect(taskState).toBe("DONE");
  });
});
