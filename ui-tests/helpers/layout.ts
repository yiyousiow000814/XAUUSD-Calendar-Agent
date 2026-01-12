import type { Page } from "@playwright/test";

type Box = { x: number; y: number; width: number; height: number };

export const injectLayoutShiftObserver = async (page: Page) => {
  await page.addInitScript(() => {
    (window as unknown as { __layoutShifts?: number[] }).__layoutShifts = [];
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      entries.forEach((entry) => {
        const shift = entry as LayoutShift;
        if (shift.hadRecentInput) return;
        (window as unknown as { __layoutShifts?: number[] }).__layoutShifts?.push(
          shift.value
        );
      });
    });
    observer.observe({ type: "layout-shift", buffered: true });
  });
};

export const resetLayoutShift = async (page: Page) => {
  await page.evaluate(() => {
    (window as unknown as { __layoutShifts?: number[] }).__layoutShifts = [];
  });
};

export const getLayoutShiftScore = async (page: Page) => {
  return page.evaluate(() => {
    const shifts = (window as unknown as { __layoutShifts?: number[] }).__layoutShifts || [];
    return shifts.reduce((sum, value) => sum + value, 0);
  });
};

export const getBox = async (page: Page, selector: string): Promise<Box | null> => {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, selector);
};

export const boxDelta = (before: Box | null, after: Box | null) => {
  if (!before || !after) return null;
  return {
    dx: Math.abs(before.x - after.x),
    dy: Math.abs(before.y - after.y),
    dw: Math.abs(before.width - after.width),
    dh: Math.abs(before.height - after.height)
  };
};
