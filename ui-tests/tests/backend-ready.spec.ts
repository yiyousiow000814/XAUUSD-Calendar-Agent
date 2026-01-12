import { expect, test } from "@playwright/test";

test("desktop runtime waits for backend instead of rendering mock events", async ({ browser }) => {
  const context = await browser.newContext({ userAgent: "XAUUSDCalendar/1.0" });
  const page = await context.newPage();

  await page.addInitScript(() => {
    // Test-only mock: the real app version is owned by the desktop backend (APP_VERSION).
    const snapshot = {
      lastPull: "Not yet",
      lastSync: "Not yet",
      outputDir: "",
      repoPath: "",
      currency: "USD",
      currencyOptions: ["ALL", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"],
      events: [],
      pastEvents: [],
      logs: [],
      version: "0.0.0"
    };

    const settings = {
      autoSyncAfterPull: true,
      autoUpdateEnabled: true,
      autoUpdateIntervalMinutes: 60,
      runOnStartup: true,
      debug: false,
      autoSave: true,
      enableSystemTheme: false,
      theme: "dark",
      syncRepoPath: "",
      repoPath: "",
      logPath: "",
      removeLogs: true,
      removeOutput: false,
      removeSyncRepos: true,
      uninstallConfirm: ""
    };

    window.setTimeout(() => {
      (window as unknown as { pywebview?: unknown }).pywebview = {
        api: {
          get_snapshot: () => Promise.resolve(snapshot),
          get_settings: () => Promise.resolve(settings),
          set_currency: () => Promise.resolve({ ok: true })
        }
      };
      window.dispatchEvent(new Event("pywebviewready"));
    }, 300);
  });

  await page.goto("/");

  await expect(page.locator("[data-qa='qa:overlay:init']")).toBeVisible();
  await expect(page.getByText("FOMC Member Kaplan Speaks")).toHaveCount(0);

  await expect(page.locator("[data-qa='qa:overlay:init']")).toBeHidden();
  await expect(page.locator("[data-qa='qa:row:next-event:empty']")).toBeVisible();

  await context.close();
});

