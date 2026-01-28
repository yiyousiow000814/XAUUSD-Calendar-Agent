# Tauri + Rust (WebView2) Desktop App

This folder hosts the new desktop runtime built with **Tauri (v2)** and a **Rust** backend.
The existing React/Vite UI under `app/webui` is reused as-is.

## Prerequisites (Windows)

- Node.js (includes `npm`)
- Rust toolchain (`rustup`, `cargo`, `rustc`)
- WebView2 Runtime (normally already present on Windows 10/11)

## Development

From the repo root:

1. Build and run the web UI dev server:
   - The Tauri config runs `npm --prefix ../webui run dev -- --host` automatically.
2. Start the Tauri app:
   - `cd app/tauri`
   - `npm install`
   - `npm run dev`

## Production build

From the repo root:

- `cd app/tauri`
- `npm install`
- `npm run build`

Tauri outputs the Windows binaries and bundles under `app/tauri/src-tauri/target/`.

## Notes

- Commands are exposed via `tauri::command` in `src-tauri/src/main.rs`.
- The frontend talks to the backend via `window.__TAURI__.core.invoke`.
