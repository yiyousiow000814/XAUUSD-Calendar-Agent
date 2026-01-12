import type { Locator, Page, TestInfo } from "@playwright/test";
import { captureElement, sanitizeName, currentDir, ensureDir } from "./screenshots";
import path from "node:path";

export type AnimationCheckResult = {
  selector: string;
  reason: string;
};

export const checkAnimations = async (
  page: Page,
  selector: string,
  testInfo: TestInfo
): Promise<AnimationCheckResult[]> => {
  const elements = await page.locator(selector).all();
  if (!elements.length) return [];

  const snapshots = await page.evaluate((sel) => {
    const els = Array.from(document.querySelectorAll(sel));
    return els.map((el) => {
      const style = window.getComputedStyle(el);
      return {
        animationName: style.animationName,
        animationPlayState: style.animationPlayState,
        transform: style.transform
      };
    });
  }, selector);

  await page.waitForTimeout(240);

  const later = await page.evaluate((sel) => {
    const els = Array.from(document.querySelectorAll(sel));
    return els.map((el) => {
      const style = window.getComputedStyle(el);
      return {
        animationName: style.animationName,
        animationPlayState: style.animationPlayState,
        transform: style.transform
      };
    });
  }, selector);

  const failures: AnimationCheckResult[] = [];

  for (let i = 0; i < elements.length; i += 1) {
    const first = snapshots[i];
    const second = later[i];
    const hasAnimation =
      first.animationName !== "none" && first.animationPlayState === "running";
    const transformChanged = first.transform !== second.transform;
    if (!hasAnimation && !transformChanged) {
      failures.push({ selector: `${selector}[${i}]`, reason: "Animation did not change" });
    }

    const name = `${sanitizeName(selector)}-${i}`;
    const folder = path.join(currentDir, "animation");
    await ensureDir(folder);
    const locator = elements[i];
    await captureElement(locator, "animation", name, testInfo);
  }

  return failures;
};
