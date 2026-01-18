import type { Page } from "@playwright/test";

type OverlapIssue = {
  first: string;
  second: string;
  area: number;
};

type OverlapOptions = {
  scopeSelector?: string;
  targetSelector: string;
};

const getLabel = (el: Element) =>
  el.getAttribute("data-qa") || el.getAttribute("data-testid") || el.tagName.toLowerCase();

export const checkOverlap = async (
  page: Page,
  { scopeSelector, targetSelector }: OverlapOptions
): Promise<OverlapIssue[]> => {
  const issues: OverlapIssue[] = await page.evaluate(
    ({ scopeSelector, targetSelector }) => {
      const root = scopeSelector ? document.querySelector(scopeSelector) : document.body;
      if (!root) return [];
      const targets = Array.from(root.querySelectorAll(targetSelector)).filter((el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      });

      const overlaps: OverlapIssue[] = [];
      for (let i = 0; i < targets.length; i += 1) {
        const a = targets[i];
        const rectA = a.getBoundingClientRect();
        for (let j = i + 1; j < targets.length; j += 1) {
          const b = targets[j];
          if (a.contains(b) || b.contains(a)) continue;
          const rectB = b.getBoundingClientRect();
          const xOverlap = Math.max(
            0,
            Math.min(rectA.right, rectB.right) - Math.max(rectA.left, rectB.left)
          );
          const yOverlap = Math.max(
            0,
            Math.min(rectA.bottom, rectB.bottom) - Math.max(rectA.top, rectB.top)
          );
          const area = xOverlap * yOverlap;
          if (area > 1) {
            overlaps.push({
              first: (a.getAttribute("data-qa") || a.getAttribute("data-testid") || a.tagName)
                .toString(),
              second: (b.getAttribute("data-qa") || b.getAttribute("data-testid") || b.tagName)
                .toString(),
              area
            });
          }
        }
      }
      return overlaps;
    },
    { scopeSelector, targetSelector }
  );

  return issues;
};

export type { OverlapIssue };
