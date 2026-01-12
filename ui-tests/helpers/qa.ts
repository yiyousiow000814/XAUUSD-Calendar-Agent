import type { Page } from "@playwright/test";

export type QaElement = {
  selector: string;
  index: number;
  qa: string;
  tokens: string[];
  kind: string;
  name: string;
};

const qaSelector = "[data-qa], [data-testid]";

const extractTokens = (value: string) =>
  value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

export const collectQaElements = async (page: Page): Promise<QaElement[]> => {
  const raw = await page.$$eval(qaSelector, (elements) => {
    return elements
      .map((el) => {
        const qaValue = el.getAttribute("data-qa");
        const testId = el.getAttribute("data-testid");
        const tokens = [qaValue, testId]
          .filter(Boolean)
          .flatMap((value) => (value || "").split(/\s+/));
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none";
        return {
          qaValue: qaValue || testId || "",
          tokens,
          visible
        };
      })
      .filter((item) => item.qaValue && item.visible);
  });

  const entries: QaElement[] = [];
  raw.forEach((item) => {
    const tokens = extractTokens(item.qaValue);
    const qaToken = tokens.find((token) => token.startsWith("qa:")) || tokens[0];
    if (!qaToken) return;
    const selector = qaToken.startsWith("qa:")
      ? `[data-qa~="${qaToken}"], [data-testid~="${qaToken}"]`
      : `[data-qa="${qaToken}"], [data-testid="${qaToken}"]`;
    const [kind, name] = qaToken.startsWith("qa:")
      ? qaToken.replace("qa:", "").split(":")
      : ["unknown", qaToken];
    const existing = entries.filter((entry) => entry.selector === selector).length;
    entries.push({
      selector,
      index: existing,
      qa: qaToken,
      tokens,
      kind: kind || "unknown",
      name: name || "item"
    });
  });
  return entries;
};

export const ensureAppShell = async (page: Page) => {
  const root = page.locator('[data-qa="qa:app-shell"], [data-testid="qa:app-shell"]');
  if (await root.count()) {
    await root.first().waitFor({ state: "visible", timeout: 10000 });
    return;
  }
  const anyQa = page.locator(qaSelector);
  if ((await anyQa.count()) === 0) {
    throw new Error("No qa/testid elements found. Tag the app shell with qa:app-shell.");
  }
  await anyQa.first().waitFor({ state: "visible", timeout: 10000 });
};

export const qaSelectorAll = qaSelector;
