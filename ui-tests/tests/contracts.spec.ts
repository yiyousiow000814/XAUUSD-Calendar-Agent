import { test, expect, type Locator, type Page } from "@playwright/test";
import { collectQaElements, ensureAppShell } from "../helpers/qa";
import { checkContrast } from "../helpers/contrast";
import { checkOverlap } from "../helpers/overlap";
import { checkAnimations } from "../helpers/animation";
import {
  injectLayoutShiftObserver,
  resetLayoutShift,
  getLayoutShiftScore,
  getBox,
  boxDelta
} from "../helpers/layout";
import { setTheme } from "../helpers/theme";

const asyncActionSelector = "[data-qa*='qa:action:async'], [data-testid*='qa:action:async']";
const modalTriggerSelector = "[data-qa*='qa:modal-trigger:'], [data-testid*='qa:modal-trigger:']";
const modalSelector = "[data-qa*='qa:modal:'], [data-testid*='qa:modal:']";
const modalBackdropSelector =
  "[data-qa*='qa:modal-backdrop:'], [data-testid*='qa:modal-backdrop:']";
const modalHeaderSelector = "[data-qa*='qa:modal-header:'], [data-testid*='qa:modal-header:']";
const modalCloseSelector = "[data-qa*='qa:modal-close:'], [data-testid*='qa:modal-close:']";
const modalBodySelector = "[data-qa*='qa:modal-body:'], [data-testid*='qa:modal-body:']";
const autosaveToggleSelector =
  "[data-qa*='qa:control:autosave'] input, [data-testid*='qa:control:autosave'] input";
const autosaveStatusSelector =
  "[data-qa*='qa:status:autosave'], [data-testid*='qa:status:autosave']";
const controlSelector =
  "[data-qa*='qa:action:'], [data-qa*='qa:control:'], [data-qa*='qa:toolbar:'], [data-qa*='qa:modal-footer:'], [data-qa*='qa:modal-header:']";
const spinnerSelector = "[data-qa*='qa:spinner:'], [data-testid*='qa:spinner:']";
const transitionSelector = "[data-qa*='qa:transition:'], [data-testid*='qa:transition:']";

const rootSelector = "[data-qa='qa:app-shell'], [data-testid='qa:app-shell']";

const openModal = async (page: Page, trigger: Locator) => {
  await trigger.click();
  await page.waitForTimeout(200);
};

const closeModal = async (page: Page) => {
  const close = page.locator(modalCloseSelector).first();
  if (await close.count()) {
    await close.click();
    await page.waitForTimeout(200);
  }
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __themeSamples?: string[] }).__themeSamples = [];
    const sample = () => {
      (window as unknown as { __themeSamples?: string[] }).__themeSamples?.push(
        document.documentElement.dataset.theme || ""
      );
    };
    document.addEventListener("DOMContentLoaded", sample, { once: true });
    window.setTimeout(sample, 50);
    window.setTimeout(sample, 200);
  });
  await injectLayoutShiftObserver(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await ensureAppShell(page);
});

test("Blank page guard", async ({ page }) => {
  const root = page.locator(rootSelector);
  await expect(root).toBeVisible();
});

test("Next Events impact filter tooltip contract", async ({ page }) => {
  const filter = page.locator("[data-qa='qa:filter:impact']").first();
  test.skip((await filter.count()) === 0, "No impact filter found");

  const buttons = filter.locator("button.impact-toggle");
  await expect(buttons).toHaveCount(3);

  const expected = ["Low Impact", "Medium Impact", "High Impact"];
  for (let index = 0; index < expected.length; index += 1) {
    await expect(buttons.nth(index)).toHaveAttribute("aria-label", expected[index]);

    const tooltip = buttons.nth(index).locator(".impact-tooltip").first();
    await expect(tooltip).toHaveText(expected[index]);

    await buttons.nth(index).hover();
    await page.waitForTimeout(120);
    const opacity = await tooltip.evaluate((node) => {
      const value = window.getComputedStyle(node).opacity;
      return Number.parseFloat(value || "0");
    });
    expect(opacity).toBeGreaterThan(0.85);
  }
});

test("Currency select caret padding contract", async ({ page }) => {
  const select = page.locator("[data-qa='qa:select:currency']").first();
  test.skip((await select.count()) === 0, "No currency select found");

  const trigger = select.locator(".select-trigger").first();
  const caret = trigger.locator(".select-caret").first();

  const [triggerBox, caretBox] = await Promise.all([trigger.boundingBox(), caret.boundingBox()]);
  expect(triggerBox).toBeTruthy();
  expect(caretBox).toBeTruthy();
  if (!triggerBox || !caretBox) return;

  expect(caretBox.x).toBeGreaterThan(triggerBox.x + triggerBox.width - 48);
  expect(caretBox.x + caretBox.width).toBeLessThanOrEqual(triggerBox.x + triggerBox.width - 10);

  const triggerCenterY = triggerBox.y + triggerBox.height / 2;
  const caretCenterY = caretBox.y + caretBox.height / 2;
  expect(Math.abs(triggerCenterY - caretCenterY)).toBeLessThanOrEqual(6);
});

test("Theme flash contract", async ({ page }) => {
  const samples = await page.evaluate(() => {
    return (window as unknown as { __themeSamples?: string[] }).__themeSamples || [];
  });
  const normalized = samples.filter(Boolean);
  if (normalized.length < 2) return;
  const unique = Array.from(new Set(normalized));
  expect(unique.length).toBeLessThanOrEqual(1);
});

test("Theme readability contract", async ({ page }) => {
  const variants: Array<{ name: string; mode: "dark" | "light" | "system"; scheme?: "dark" | "light" }> = [
    { name: "dark", mode: "dark" },
    { name: "light", mode: "light" },
    { name: "system-dark", mode: "system", scheme: "dark" },
    { name: "system-light", mode: "system", scheme: "light" }
  ];

  for (const variant of variants) {
    await setTheme(page, variant.mode, variant.scheme);
    await page.waitForTimeout(200);
    const failures = await checkContrast(page, { scopeSelector: rootSelector, sampleLimit: 160 });
    expect(failures, `Contrast failures in ${variant.name}: ${JSON.stringify(failures)}`).toEqual(
      []
    );
  }
});

test("Settings visibility contract", async ({ page }) => {
  const variants: Array<{ name: string; mode: "dark" | "light" | "system"; scheme?: "dark" | "light" }> = [
    { name: "dark", mode: "dark" },
    { name: "light", mode: "light" },
    { name: "system-dark", mode: "system", scheme: "dark" },
    { name: "system-light", mode: "system", scheme: "light" }
  ];

  const trigger = page.locator(modalTriggerSelector).first();
  if ((await trigger.count()) === 0) {
    test.skip(true, "No settings modal trigger found");
  }

  for (const variant of variants) {
    await setTheme(page, variant.mode, variant.scheme);
    await page.waitForTimeout(200);
    await trigger.click();
    const modal = page.locator(modalSelector).first();
    await expect(modal).toBeVisible();
    const failures = await checkContrast(page, { scopeSelector: modalSelector, sampleLimit: 120 });
    expect(
      failures,
      `Settings contrast failures in ${variant.name}: ${JSON.stringify(failures)}`
    ).toEqual([]);

    if (variant.name.includes("light")) {
      const dividerOk = await page.evaluate((selector) => {
        const modalEl = document.querySelector(selector);
        if (!modalEl) return true;
        const sections = Array.from(modalEl.querySelectorAll(".section"));
        const parse = (value: string) => {
          const match = value.match(/rgba?\\(([^)]+)\\)/);
          if (!match) return { alpha: 1 };
          const parts = match[1].split(",").map((part) => part.trim());
          return { alpha: parts[3] ? Number(parts[3]) : 1 };
        };
        return sections.every((section) => {
          const color = window.getComputedStyle(section).borderTopColor;
          return parse(color).alpha >= 0.1;
        });
      }, modalSelector);
      expect(dividerOk).toBeTruthy();
    }

    await closeModal(page);
  }
});

test("Animation contract", async ({ page }, testInfo) => {
  const spinnerFailures = await checkAnimations(page, spinnerSelector, testInfo);
  const transitionFailures = await checkAnimations(page, transitionSelector, testInfo);
  const failures = [...spinnerFailures, ...transitionFailures];
  expect(failures, `Animation failures: ${JSON.stringify(failures)}`).toEqual([]);
});

test("Action loading state contract", async ({ page }) => {
  const actions = await page.locator(asyncActionSelector).all();
  expect(actions.length).toBeGreaterThan(0);

  for (const action of actions) {
    await resetLayoutShift(page);
    const before = await getBox(page, rootSelector);

    await action.click({ noWaitAfter: true });
    const handle = await action.elementHandle();
    if (!handle) continue;

    await page.waitForFunction(
      (el, spinnerSel) => {
        const state = el.getAttribute("data-qa-state");
        const disabled = el.hasAttribute("disabled");
        const hasSpinner = el.querySelector(spinnerSel) !== null;
        return state === "loading" || disabled || hasSpinner;
      },
      handle,
      spinnerSelector,
      { timeout: 1500 }
    );

    await page.waitForFunction(
      (el) => {
        const state = el.getAttribute("data-qa-state");
        const disabled = el.hasAttribute("disabled");
        return state === "idle" || !disabled;
      },
      handle,
      { timeout: 5000 }
    );

    const after = await getBox(page, rootSelector);
    const delta = boxDelta(before, after);
    if (delta) {
      expect(delta.dh).toBeLessThanOrEqual(12);
    }

    const shiftScore = await getLayoutShiftScore(page);
    expect(shiftScore).toBeLessThanOrEqual(0.1);
  }
});

test("Modal scroll and close visibility contract", async ({ page }) => {
  const triggers = await page.locator(modalTriggerSelector).all();
  test.skip(!triggers.length, "No modal triggers found");

  await page.setViewportSize({ width: 1024, height: 720 });

  for (const trigger of triggers) {
    await openModal(page, trigger);
    const modal = page.locator(modalSelector).first();
    await expect(modal).toBeVisible();

    const backdrop = page.locator(modalBackdropSelector).first();
    await expect(backdrop).toBeVisible();
    const backdropBox = await backdrop.boundingBox();
    const viewport = page.viewportSize();
    if (backdropBox && viewport) {
      expect(backdropBox.width).toBeGreaterThanOrEqual(viewport.width - 2);
      expect(backdropBox.height).toBeGreaterThanOrEqual(viewport.height - 2);
    }

    const header = modal.locator(modalHeaderSelector).first();
    if (await header.count()) {
      const headerBox = await header.boundingBox();
      const closeButton = modal.locator(modalCloseSelector).first();
      const closeBox = await closeButton.boundingBox();
      if (headerBox && closeBox) {
        const headerCenter = headerBox.y + headerBox.height / 2;
        const closeCenter = closeBox.y + closeBox.height / 2;
        expect(Math.abs(headerCenter - closeCenter)).toBeLessThanOrEqual(6);
      }
      if (headerBox) {
        expect(headerBox.y).toBeGreaterThanOrEqual(4);
      }
    }

    const closeButtons = await modal.locator(modalCloseSelector).all();
    expect(closeButtons.length).toBe(1);

    const closeBox = await closeButtons[0].boundingBox();
    expect(closeBox).toBeTruthy();
    if (closeBox) {
      expect(closeBox.y).toBeGreaterThanOrEqual(0);
      expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(720);
    }

    const body = modal.locator(modalBodySelector).first();
    if (await body.count()) {
      const overflow = await body.evaluate((el) => window.getComputedStyle(el).overflowY);
      expect(["auto", "scroll"]).toContain(overflow);
    }

    await closeModal(page);
  }
});

test("Autosave status stability contract", async ({ page }) => {
  const trigger = page.locator(modalTriggerSelector).first();
  if ((await trigger.count()) === 0) {
    test.skip(true, "No settings modal trigger found");
  }

  await openModal(page, trigger);
  const modal = page.locator(modalSelector).first();
  await expect(modal).toBeVisible();

  const autosaveToggle = page.locator(autosaveToggleSelector).first();
  const autosaveStatus = page.locator(autosaveStatusSelector).first();
  if ((await autosaveToggle.count()) === 0 || (await autosaveStatus.count()) === 0) {
    test.skip(true, "Autosave controls not tagged");
  }

  const autosaveChecked = await autosaveToggle.isChecked();
  if (!autosaveChecked) {
    test.skip(true, "Autosave disabled; skip stability check");
  }

  const before = await getBox(page, modalSelector);
  const beforeSectionHeight = await autosaveStatus.evaluate((el) => {
    const section = el.closest(".section");
    return section ? section.getBoundingClientRect().height : 0;
  });
  const intervalInput = modal.locator('input[type="number"]').first();
  const current = await intervalInput.inputValue();
  const nextValue = String(Number(current || "0") + 1);
  await intervalInput.fill(nextValue);
  await intervalInput.blur();
  await page.waitForTimeout(900);
  await expect(autosaveStatus).toBeVisible();
  await page.waitForTimeout(700);
  const after = await getBox(page, modalSelector);
  const afterSectionHeight = await autosaveStatus.evaluate((el) => {
    const section = el.closest(".section");
    return section ? section.getBoundingClientRect().height : 0;
  });
  const delta = boxDelta(before, after);
  if (delta) {
    expect(delta.dh).toBeLessThanOrEqual(6);
  }
  expect(Math.abs(beforeSectionHeight - afterSectionHeight)).toBeLessThanOrEqual(2);

  await closeModal(page);
});

test("Overlap contract", async ({ page }) => {
  const qaElements = await collectQaElements(page);
  const containers = qaElements.filter((item) => ["card", "modal", "toolbar"].includes(item.kind));

  for (const container of containers) {
    const issues = await checkOverlap(page, {
      scopeSelector: container.selector,
      targetSelector: controlSelector
    });
    expect(issues, `Overlap detected in ${container.qa}: ${JSON.stringify(issues)}`).toEqual([]);
  }
});

test("Error visibility contract", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  if (consoleErrors.length > 0) {
    const overlay = page.locator("[data-qa*='qa:overlay:'], text=/UI Failed to Load|Initialization failed/i");
    await expect(overlay).toBeVisible();
  }
});
