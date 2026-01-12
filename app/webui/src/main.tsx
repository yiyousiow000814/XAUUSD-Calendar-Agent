import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/base.css";

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
