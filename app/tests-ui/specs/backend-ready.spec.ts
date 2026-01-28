import { expect, test } from "@playwright/test";

test("desktop runtime waits for backend instead of rendering mock events", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.addInitScript(() => {
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
      runOnStartup: true,
      autostartLaunchMode: "tray",
      closeBehavior: "exit",
      debug: false,
      autoSave: true,
      splitRatio: 0.66,
      enableSystemTheme: false,
      theme: "dark",
      calendarTimezoneMode: "system",
      calendarUtcOffsetMinutes: 0,
      enableTemporaryPath: false,
      temporaryPath: "",
      repoPath: "",
      logPath: "",
      removeLogs: true,
      removeOutput: false,
      removeTemporaryPaths: true,
      uninstallConfirm: ""
    };

    const invoke = (command: string, args?: Record<string, unknown>) =>
      new Promise((resolve) => {
        window.setTimeout(() => {
          if (command === "get_snapshot") return resolve(snapshot);
          if (command === "get_settings") return resolve(settings);
          if (command === "set_currency") return resolve({ ok: true });
          if (command === "frontend_boot_complete") return resolve({ ok: true });
          if (command === "set_ui_state") return resolve({ ok: true });
          return resolve({ ok: false });
        }, 300);
      });

    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
  });

  await page.goto("/");

  await expect(page.locator("[data-qa='qa:overlay:init']")).toBeVisible();
  await expect(page.getByText("FOMC Member Kaplan Speaks")).toHaveCount(0);

  await expect(page.locator("[data-qa='qa:overlay:init']")).toBeHidden();
  await expect(page.locator("[data-qa='qa:row:next-event:empty']")).toBeVisible();

  await context.close();
});

