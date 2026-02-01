import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    // Windows occasionally fails to delete `dist/assets` due to file locks during ui-check.
    // Vite emits content-hashed asset names, so leaving stale assets is safe for local builds.
    emptyOutDir: process.platform !== "win32",
    chunkSizeWarningLimit: 1100
  }
});
