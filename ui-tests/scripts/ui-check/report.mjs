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
    img { width: 260px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.15); }
    .label { font-size: 12px; color: #a6a9b3; }
    a { color: #86c9ff; }
  </style>
  </head>
  <body>
    <h1>UI Check Report</h1>
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
                    return `
                      <div class="cell">
                        <img src="${path
                          .relative(artifactsRoot, entry.path)
                          .replace(/\\\\/g, "/")}" />
                        <div class="label">${entry.label ?? entry.state}</div>
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
    <h2>Videos</h2>
    <ul>
      ${videos
        .map(
          (video) =>
            `<li><a href="${path
              .relative(artifactsRoot, video)
              .replace(/\\\\/g, "/")}">${path.basename(video)}</a></li>`
        )
        .join("")}
    </ul>
  </body>
  </html>`;
  await fs.writeFile(reportPath, html, "utf-8");
};
