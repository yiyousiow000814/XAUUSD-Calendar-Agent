import path from "node:path";
import { promises as fs } from "node:fs";

export const generateReport = async (items, videos, { artifactsRoot, reportPath }) => {
  const order = ["dark", "light", "system-dark", "system-light"];
  const themes = Array.from(new Set(items.map((item) => item.theme)))
    .sort((a, b) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  const grouped = items.reduce((acc, item) => {
    acc[item.scenario] = acc[item.scenario] || {};
    acc[item.scenario][item.state] = acc[item.scenario][item.state] || {};
    acc[item.scenario][item.state][item.theme] = item;
    return acc;
  }, {});

  const rel = (target) => path.relative(artifactsRoot, target).replace(/\\\\/g, "/");
  const escapeHtml = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>UI Check Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; background: #0b0d10; color: #f7f6f2; }
    h2 { margin-top: 28px; }
    .group { margin-bottom: 28px; }
    .theme-grid { display: grid; gap: 12px; }
    .row { display: grid; gap: 12px; align-items: start; margin-bottom: 16px; }
    .row-header { font-size: 12px; color: #a6a9b3; text-transform: uppercase; letter-spacing: 0.16em; }
    .cell { display: flex; flex-direction: column; gap: 6px; }
    img, video { width: min(720px, 100%); border-radius: 10px; border: 1px solid rgba(255,255,255,0.15); background: #07090c; }
    video { display: block; }
    .label { font-size: 12px; color: #a6a9b3; }
    .muted { font-size: 12px; color: rgba(166,169,179,0.75); }
    .anim { position: relative; }
    .anim-badge { position: absolute; top: 10px; left: 10px; padding: 4px 8px; border-radius: 999px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.18); color: rgba(255,255,255,0.9); }
    a { color: #86c9ff; }
  </style>
  </head>
  <body>
    <h1>UI Check Report</h1>
    <p class="muted">GIF previews animate only when opened in a real browser (Edge/Chrome). Some file viewers (GitHub/VSCode) render the first frame only.</p>
    <p>Artifacts: ${artifactsRoot}</p>
    ${Object.entries(grouped)
      .map(
        ([scenario, states]) => `
        <div class="group">
          <h2>${scenario}</h2>
          <div class="theme-grid">
            <div class="row" style="grid-template-columns: 160px repeat(${themes.length}, 1fr);">
              <div class="row-header">State</div>
              ${themes.map((theme) => `<div class="row-header">${theme}</div>`).join("")}
            </div>
            ${Object.entries(states)
              .map(([state, byTheme]) => {
                const columns = themes
                  .map((theme) => {
                    const entry = byTheme[theme];
                    if (!entry) return `<div class="cell"><div class="label">-</div></div>`;
                    const hasFrames = Array.isArray(entry.frames) && entry.frames.length > 1;
                    if (hasFrames) {
                      const frames = entry.frames.map((frame) => rel(frame));
                      return `
                        <div class="cell">
                          <div class="anim" data-frames='${escapeHtml(JSON.stringify(frames))}' data-gap='${escapeHtml(entry.frameGapMs || 120)}'>
                            <span class="anim-badge">gif</span>
                            <img src="${escapeHtml(frames[0])}" />
                          </div>
                          <div class="label">${escapeHtml(entry.label ?? entry.state)}</div>
                          <div class="muted">${frames.length} frames</div>
                        </div>`;
                    }
                    return `
                      <div class="cell">
                        <img src="${escapeHtml(rel(entry.path))}" />
                        <div class="label">${escapeHtml(entry.label ?? entry.state)}</div>
                      </div>`;
                  })
                  .join("");
                return `
                  <div class="row" style="grid-template-columns: 160px repeat(${themes.length}, 1fr);">
                    <div class="label">${state}</div>
                    ${columns}
                  </div>`;
              })
              .join("")}
          </div>
        </div>`
      )
      .join("")}
    ${
      videos.length
        ? `
    <h2>Videos</h2>
    <p class="muted">Note: WebM capture is opt-in. Enable with UI_CHECK_VIDEO=1. On some Windows setups recordVideo can appear cropped/zoomed; the frame-based GIF previews are the reliable source of truth.</p>
    <div class="group">
      ${videos
        .map((video) => {
          const src = rel(video);
          const name = path.basename(video);
          return `
            <div class="cell" style="margin-bottom: 18px;">
              <div class="label">${escapeHtml(name)}</div>
              <video src="${escapeHtml(src)}" controls playsinline muted loop></video>
              <div class="muted"><a href="${escapeHtml(src)}">Open ${escapeHtml(name)}</a></div>
            </div>`;
        })
        .join("")}
    </div>`
        : ""
    }
    <script>
      (() => {
        const nodes = Array.from(document.querySelectorAll('.anim'));
        nodes.forEach((node) => {
          let frames = [];
          try { frames = JSON.parse(node.dataset.frames || '[]'); } catch { frames = []; }
          if (!Array.isArray(frames) || frames.length < 2) return;
          const gap = Math.max(60, Number(node.dataset.gap || 120));
          const img = node.querySelector('img');
          if (!img) return;
          let i = 0;
          window.setInterval(() => {
            i = (i + 1) % frames.length;
            img.src = frames[i];
          }, gap);
        });
      })();
    </script>
  </body>
  </html>`;
  await fs.writeFile(reportPath, html, "utf-8");
};
