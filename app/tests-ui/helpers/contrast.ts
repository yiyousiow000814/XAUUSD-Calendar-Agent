import type { Page } from "@playwright/test";

type ContrastFailure = {
  text: string;
  ratio: number;
  color: string;
  background: string;
  selector: string;
  fontSize: number;
  fontWeight: number;
};

type ContrastOptions = {
  scopeSelector?: string;
  sampleLimit?: number;
};

export const checkContrast = async (page: Page, options: ContrastOptions = {}) => {
  const failures: ContrastFailure[] = await page.evaluate(({ scopeSelector, sampleLimit }) => {
    const root = scopeSelector ? document.querySelector(scopeSelector) : document.body;
    if (!root) return [];

    const parseColor = (value: string) => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(",").map((part) => part.trim());
      const [r, g, b, a] = parts;
      return {
        r: Number(r),
        g: Number(g),
        b: Number(b),
        a: a === undefined ? 1 : Number(a)
      };
    };

    const getEffectiveBackground = (el: Element): string => {
      let node: Element | null = el as Element;
      while (node) {
        const style = window.getComputedStyle(node);
        const bg = style.backgroundColor;
        const parsed = parseColor(bg);
        if (parsed && parsed.a >= 0.1) {
          return bg;
        }
        node = node.parentElement;
      }
      return "rgb(0,0,0)";
    };

    const luminance = (r: number, g: number, b: number) => {
      const srgb = [r, g, b].map((c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
    };

    const contrastRatio = (fg: string, bg: string) => {
      const fgParsed = parseColor(fg);
      const bgParsed = parseColor(bg);
      if (!fgParsed || !bgParsed) return null;
      const fgLum = luminance(fgParsed.r, fgParsed.g, fgParsed.b);
      const bgLum = luminance(bgParsed.r, bgParsed.g, bgParsed.b);
      const lighter = Math.max(fgLum, bgLum);
      const darker = Math.min(fgLum, bgLum);
      return (lighter + 0.05) / (darker + 0.05);
    };

    const isVisible = (el: Element) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const elements = Array.from(root.querySelectorAll("*"))
      .filter((el) => isVisible(el) && el.textContent && el.textContent.trim().length > 2)
      .slice(0, sampleLimit || 120);

    const failures: ContrastFailure[] = [];

    elements.forEach((el) => {
      const style = window.getComputedStyle(el);
      const fg = style.color;
      const bg = getEffectiveBackground(el);
      const ratio = contrastRatio(fg, bg);
      if (!ratio) return;
      const fontSize = Number.parseFloat(style.fontSize);
      const fontWeight = Number.parseInt(style.fontWeight || "400", 10) || 400;
      const isLarge = fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700);
      const threshold = isLarge ? 3.0 : 4.5;
      if (ratio < threshold) {
        failures.push({
          text: el.textContent?.trim().slice(0, 80) || "",
          ratio,
          color: fg,
          background: bg,
          selector: el.tagName.toLowerCase(),
          fontSize,
          fontWeight
        });
      }
    });

    return failures;
  }, options);

  return failures;
};

export type { ContrastFailure };
