import { test, expect } from "@playwright/test";
import { collectQaElements, ensureAppShell } from "../helpers/qa";
import { captureElement, captureFullPage } from "../helpers/screenshots";
import { setTheme } from "../helpers/theme";

const VIEWPORTS = [
  { name: "small", width: 1024, height: 720 },
  { name: "medium", width: 1366, height: 900 },
  { name: "large", width: 1920, height: 1080 }
];

const THEMES = [
  { name: "dark", mode: "dark" as const },
  { name: "light", mode: "light" as const }
];

const captureKinds = new Set([
  "card",
  "section",
  "modal",
  "menu",
  "toast",
  "badge",
  "toolbar",
  "panel",
  "overlay",
  "header"
]);

test.describe("Discovery", () => {
  for (const viewport of VIEWPORTS) {
    test(`collect qa blocks (${viewport.name})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await ensureAppShell(page);

      for (const theme of THEMES) {
        await setTheme(page, theme.mode);
        await page.waitForTimeout(200);

        const qaElements = await collectQaElements(page);
        const targets = qaElements.filter((item) => captureKinds.has(item.kind));

        expect(qaElements.length).toBeGreaterThan(0);

        const label = `${viewport.name}-${theme.name}`;
        await captureFullPage(page, label, testInfo);

        for (const target of targets) {
          const locator = page.locator(target.selector).nth(target.index);
          await locator.scrollIntoViewIfNeeded();
          await captureElement(locator, label, target.qa, testInfo);
        }

        const hoverTargets = page.locator("[data-qa*='qa:action:']").all();
        for (const target of await hoverTargets) {
          try {
            await target.hover();
            await page.waitForTimeout(120);
            const qa = (await target.getAttribute("data-qa")) || "qa:action:hover";
            await captureElement(target, label, `${qa}-hover`, testInfo);
          } catch {
            // Ignore hover failures for offscreen or disabled elements.
          }
        }

        const modalTrigger = page.locator("[data-qa*='qa:modal-trigger:']").first();
        if ((await modalTrigger.count()) > 0) {
          await modalTrigger.click();
          await page.waitForTimeout(200);
          const modal = page.locator("[data-qa*='qa:modal:']").first();
          if (await modal.count()) {
            await captureElement(modal, label, "qa:modal:settings", testInfo);
            const modalBody = page.locator("[data-qa*='qa:modal-body:']").first();
            if (await modalBody.count()) {
              await modalBody.evaluate((el) => {
                el.scrollTop = el.scrollHeight;
              });
              await page.waitForTimeout(200);
              await captureElement(modal, label, "qa:modal:settings-bottom", testInfo);
            }
          }
          const closeButton = page.locator("[data-qa*='qa:modal-close:']").first();
          if ((await closeButton.count()) > 0) {
            await closeButton.click();
            await page.waitForTimeout(200);
          }
        }
      }
    });
  }
});
