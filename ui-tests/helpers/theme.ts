import type { Page } from "@playwright/test";

type ThemeMode = "dark" | "light" | "system";

export const setTheme = async (page: Page, mode: ThemeMode, colorScheme?: "dark" | "light") => {
  if (colorScheme) {
    await page.emulateMedia({ colorScheme });
  }
  await page.evaluate((theme) => {
    const resolveTheme = () => {
      if (theme !== "system") return theme;
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      return prefersDark ? "dark" : "light";
    };
    const resolved = resolveTheme();
    try {
      localStorage.setItem("theme", theme);
      localStorage.setItem("themePreference", theme);
    } catch {
      // ignore
    }
    document.documentElement.dataset.theme = resolved;
    const event = new CustomEvent("themechange", { detail: { theme: resolved } });
    window.dispatchEvent(event);
  }, mode);
};
