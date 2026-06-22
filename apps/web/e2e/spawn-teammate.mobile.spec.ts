import { expect, test, type Page } from "@playwright/test";

async function renderSpawnTeammateRow(page: Page) {
  await page.goto("/");
  await page.setContent(`
    <!doctype html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="/src/styles/tokens.css" />
        <link rel="stylesheet" href="/src/styles/base.css" />
        <link rel="stylesheet" href="/src/styles/chat.css" />
        <style>
          body { margin: 0; background: var(--paper); }
          .spec-shell {
            width: 390px;
            min-height: 844px;
            padding: 14px;
            box-sizing: border-box;
          }
        </style>
      </head>
      <body>
        <main class="spec-shell">
          <section class="chat-messages">
            <div class="message-row message-row--tool-pair message-row--teammate">
              <button class="tool-pair-row tool-pair-row--teammate" type="button" aria-expanded="false">
                <span class="tool-pair-row__icon tool-pair-row__icon--running" aria-hidden="true">⏳</span>
                <span class="tool-pair-row__name tool-pair-row__name--teammate">
                  <span class="tool-pair-row__teammate-arrow" aria-hidden="true">→</span> coder
                </span>
                <span class="tool-pair-row__teammate-meta">
                  <span class="tool-pair-row__teammate-chip">gpt-5.3-codex-very-long-model-name</span>
                  <span class="tool-pair-row__teammate-chip">12m 05s</span>
                  <span class="tool-pair-row__teammate-chip">Tools 18</span>
                  <span class="tool-pair-row__teammate-chip">123.4k tok</span>
                </span>
                <span class="tool-pair-row__teammate-last">Edited /opt/acme/workspace/sample-app/apps/api/src/services/manager-automation/autonomous-loop/manager-tools-adapter.ts and found the broken renderer.</span>
                <span class="tool-pair-row__teammate-status tool-pair-row__teammate-status--running">running · 128 events</span>
                <span class="tool-pair-row__chevron">▸</span>
              </button>
            </div>
          </section>
        </main>
      </body>
    </html>
  `, { waitUntil: "networkidle" });
}

test.describe("spawn_teammate mobile rendering", () => {
  test("delegation row header stays inside the mobile chat frame", async ({ page }) => {
    await renderSpawnTeammateRow(page);

    const metrics = await page.locator(".tool-pair-row--teammate").evaluate((node: HTMLElement) => {
      const row = node.closest(".message-row") as HTMLElement | null;
      const children = Array.from(node.children).map((child) => {
        const rect = child.getBoundingClientRect();
        return {
          className: (child as HTMLElement).className,
          left: rect.left,
          right: rect.right,
          width: rect.width,
        };
      });
      return {
        rowClientWidth: row?.clientWidth ?? 0,
        rowScrollWidth: row?.scrollWidth ?? 0,
        headerClientWidth: node.clientWidth,
        headerScrollWidth: node.scrollWidth,
        viewportWidth: window.innerWidth,
        children,
      };
    });

    expect(metrics.rowScrollWidth).toBeLessThanOrEqual(metrics.rowClientWidth);
    expect(metrics.headerScrollWidth).toBeLessThanOrEqual(metrics.headerClientWidth);
    for (const child of metrics.children) {
      expect(child.right, `${child.className} overflows viewport`).toBeLessThanOrEqual(metrics.viewportWidth);
    }
  });
});
