import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/base.css";

const applyRuntimeHints = () => {
  // The desktop app runs inside WebView2 (pywebview). We disable some visual effects
  // in that environment to keep text crisp and avoid moire artifacts during window drag.
  try {
    const wantsDesktopRuntime =
      // ui-check marks the runtime explicitly; keep tests aligned with the desktop build.
      (typeof window !== "undefined" &&
        (window as { __UI_CHECK_RUNTIME__?: boolean }).__UI_CHECK_RUNTIME__ === true) ||
      // Real desktop app: pywebview sets a custom UA string.
      (typeof navigator !== "undefined" && navigator.userAgent.includes("XAUUSDCalendar")) ||
      // WebView2 exposes a host bridge object.
      (typeof window !== "undefined" &&
        typeof (window as { chrome?: { webview?: unknown } }).chrome?.webview !== "undefined") ||
      // pywebview also exposes a global namespace in some builds.
      (typeof window !== "undefined" &&
        typeof (window as { pywebview?: unknown }).pywebview !== "undefined");

    if (wantsDesktopRuntime) {
      document.documentElement.dataset.runtime = "desktop";
    }
  } catch {
    // Ignore runtime detection failures, fall back to CSS defaults.
  }
};

const applyInitialTheme = () => {
  try {
    const prefersDark =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = prefersDark ? "dark" : "light";
    document.documentElement.dataset.theme = resolved;
  } catch {
    // Ignore storage errors, fall back to CSS defaults.
  }
};

applyRuntimeHints();
applyInitialTheme();

const root = document.getElementById("root");
if (root) {
  try {
    createRoot(root).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  } catch (err) {
    console.error(err);
  }
}
