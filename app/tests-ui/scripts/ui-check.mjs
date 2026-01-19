import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import {
  assertAutosaveShift,
  assertBaseline,
  assertContrast,
  assertDropdownNoWrap,
  assertDropdownMenu,
  assertEventsLoaded,
  assertHistoryNoOverflow,
  assertImpactFilterNotStarved,
  assertHistoryRespectsImpactFilter,
  assertImpactTooltips,
  assertCurrentEventBadge,
  assertCurrentEventHeartbeat,
  assertNextEventsReorderAnim,
  assertNextEventsControlsCentered,
  assertSearchInputVisibility,
  assertHistoryScrollable,
  assertNoPageScroll,
  assertDesktopCrispMode,
  assertHasTransition,
  assertModalHeaderBlend,
  assertModalScroll,
  assertNoShadowClipping,
  assertOpacityTransition,
  assertTransformTransition,
  assertPathButtonAlignment,
  assertSectionRhythm,
  assertSelectVisibility,
  assertSpinnerAnim,
  assertThemeIcons
} from "./ui-check/assertions.mjs";
import { generateReport } from "./ui-check/report.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const resolveArtifactsRoot = () => {
  if (process.env.UI_CHECK_OUTPUT_DIR) {
    return path.resolve(process.env.UI_CHECK_OUTPUT_DIR);
  }
  const tag = process.env.UI_CHECK_OUTPUT_TAG;
  if (tag) {
    return path.resolve(repoRoot, "app", "tests-ui", "artifacts", "ui-check", tag);
  }
  return path.resolve(repoRoot, "app", "tests-ui", "artifacts", "ui-check");
};
const artifactsRoot = resolveArtifactsRoot();
const snapshotsDir = path.join(artifactsRoot, "snapshots");
const framesDir = path.join(artifactsRoot, "frames");
const videoDir = path.join(artifactsRoot, "video");
const reportPath = path.join(artifactsRoot, "report.html");
let baseURL = process.env.UI_BASE_URL || "http://127.0.0.1:4173";
let shouldStartServer = !process.env.UI_BASE_URL;
const defaultPort = Number.parseInt(process.env.UI_CHECK_PORT || "", 10) || 4183;
let serverState = null;

const ensureDir = async (dir) => {
  await fs.mkdir(dir, { recursive: true });
};

const clearDir = async (dir) => {
  try {
    const entries = await fs.readdir(dir);
    const rmWithRetries = async (target, attempts = 4) => {
      let lastErr = null;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          await fs.rm(target, { recursive: true, force: true });
          return;
        } catch (err) {
          lastErr = err;
          const code = err?.code;
          if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
            await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
            continue;
          }
          throw err;
        }
      }

      const code = lastErr?.code;
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
        console.warn(`WARN clearDir: skipped locked entry: ${target} (${code})`);
        return;
      }
      throw lastErr;
    };

    await Promise.all(entries.map((entry) => rmWithRetries(path.join(dir, entry))));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }
};

const sanitize = (value) => value.replace(/[^a-zA-Z0-9_-]+/g, "_");

const parsePositiveInt = (value) => {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseWorkerLimit = (value) => parsePositiveInt(value);
const parsePort = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const createMutex = () => {
  let current = Promise.resolve();
  return async (fn) => {
    let release = null;
    const ready = current;
    current = new Promise((resolve) => {
      release = resolve;
    });
    await ready;
    try {
      return await fn();
    } finally {
      release?.();
    }
  };
};

const createLimiter = (limit) => {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then((result) => {
        active -= 1;
        resolve(result);
        next();
      })
      .catch((err) => {
        active -= 1;
        reject(err);
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
};

const runWithPool = async (items, limit, runner) => {
  const errors = [];
  let index = 0;
  const next = async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      try {
        await runner(current);
      } catch (err) {
        errors.push({ item: current, error: err });
      }
    }
  };
  const workers = Array.from({ length: limit }, () => next());
  await Promise.all(workers);
  return errors;
};

const gotoWithRetries = async (page, url, options, attempts = 12) => {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await page.goto(url, options);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const retryable = msg.includes("ERR_CONNECTION_REFUSED") || msg.includes("ECONNREFUSED");
      if (!retryable || attempt === attempts) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  throw lastErr;
};

const assertSplitDividerNotDark = async (page, { minLuma = 218 } = {}) => {
  const divider = page.locator("[data-qa='qa:split:divider']").first();
  if ((await divider.count()) === 0) return;

  const buffer = await divider.screenshot();
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;
  const y0 = Math.min(height - 1, Math.floor(height * 0.15));
  const y1 = Math.max(y0 + 1, Math.floor(height * 0.85));

  const center = Math.floor(width / 2);
  const bandWidth = Math.max(4, Math.floor(width * 0.12));
  const bandGap = Math.max(3, Math.floor(width * 0.1));
  const sampleColumns = [];

  const pushBand = (xStart, xEnd) => {
    const s = Math.max(1, xStart);
    const e = Math.min(width - 2, xEnd);
    for (let x = s; x <= e; x += 1) sampleColumns.push(x);
  };

  pushBand(center - bandGap - bandWidth, center - bandGap - 1);
  pushBand(center + bandGap + 1, center + bandGap + bandWidth);

  const columnLumas = [];
  for (const x of sampleColumns) {
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y += 1) {
      const i = (width * y + x) * 4;
      const a = data[i + 3] / 255;
      if (a < 0.05) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += luma;
      count += 1;
    }
    if (!count) continue;
    columnLumas.push(sum / count);
  }

  const minBandLuma = columnLumas.length ? Math.min(...columnLumas) : NaN;
  if (!Number.isFinite(minBandLuma) || minBandLuma < minLuma) {
    throw new Error(
      `Split divider too dark (minBandLuma=${Number.isFinite(minBandLuma) ? minBandLuma.toFixed(2) : "NaN"} < ${minLuma})`
    );
  }
};

const screenshotMad = (aBuffer, bBuffer) => {
  const aPng = PNG.sync.read(aBuffer);
  const bPng = PNG.sync.read(bBuffer);
  const width = Math.min(aPng.width, bPng.width);
  const height = Math.min(aPng.height, bPng.height);
  const aCrop = new PNG({ width, height });
  const bCrop = new PNG({ width, height });
  PNG.bitblt(aPng, aCrop, 0, 0, width, height, 0, 0);
  PNG.bitblt(bPng, bCrop, 0, 0, width, height, 0, 0);

  let sum = 0;
  for (let i = 0; i < aCrop.data.length; i += 4) {
    sum += Math.abs(aCrop.data[i] - bCrop.data[i]);
    sum += Math.abs(aCrop.data[i + 1] - bCrop.data[i + 1]);
    sum += Math.abs(aCrop.data[i + 2] - bCrop.data[i + 2]);
  }
  const denom = width * height * 3 * 255;
  return denom ? sum / denom : 0;
};

const run = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: true, stdio: "inherit", ...options });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${code}`));
      }
    });
  });

const waitForPort = (port) =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.on("connect", () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - start > 30000) {
          reject(new Error("UI preview timeout"));
        } else {
          setTimeout(tick, 500);
        }
      });
    };
    tick();
  });

const canConnect = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 600);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

const isPortFree = async (port) => {
  if (await canConnect(port)) {
    return false;
  }
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
};

const startServer = async (port) => {
  const server = spawn(
    "npm",
    [
      "--prefix",
      "app/webui",
      "run",
      "preview",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort"
    ],
    { cwd: repoRoot, shell: true, stdio: "inherit" }
  );
  await Promise.race([
    waitForPort(port),
    new Promise((_, reject) => {
      server.once("exit", (code) => reject(new Error(`UI preview exited early (code=${code})`)));
      server.once("error", (err) => reject(err));
    })
  ]);
  await new Promise((r) => setTimeout(r, 120));
  if (server.exitCode !== null && typeof server.exitCode !== "undefined") {
    throw new Error(`UI preview exited early (code=${server.exitCode})`);
  }
  return server;
};

const stopServer = async (server) => {
  if (!server?.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], {
        shell: true,
        stdio: "ignore"
      });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
    return;
  }
  try {
    server.kill("SIGTERM");
  } catch {
    // ignore
  }
};

const pickPort = async (start, count = 6) => {
  for (let i = 0; i < count; i += 1) {
    const port = start + i;
    const free = await isPortFree(port);
    if (free) return port;
  }
  return null;
};

const startServerWithRetries = async (startPort, count = 6) => {
  let lastErr = null;
  for (let i = 0; i < count; i += 1) {
    const port = startPort + i;
    const free = await isPortFree(port);
    if (!free) continue;
    let server = null;
    try {
      server = await startServer(port);
      return { server, port };
    } catch (err) {
      lastErr = err;
      await stopServer(server);
    }
  }
  throw lastErr || new Error("UI preview failed to start");
};

const isConnRefused = (err) => {
  const msg = String(err?.message || err);
  return msg.includes("ERR_CONNECTION_REFUSED") || msg.includes("ECONNREFUSED");
};

const restartServer = async () => {
  if (!shouldStartServer) return;
  await stopServer(serverState?.server);
  const startPort = serverState?.port ?? defaultPort;
  serverState = await startServerWithRetries(startPort, 6);
  baseURL = `http://127.0.0.1:${serverState.port}`;
};

const gotoWithServerRecovery = async (page, url, options) => {
  try {
    return await gotoWithRetries(page, url, options);
  } catch (err) {
    if (!isConnRefused(err)) throw err;
    await restartServer();
    return await gotoWithRetries(page, baseURL, options);
  }
};

const getPortFromURL = (url) => {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
};

const captureState = async (page, scenario, theme, state, options = {}) => {
  const fileName = `${sanitize(scenario)}__${sanitize(theme)}__${sanitize(state)}.png`;
  const filePath = path.join(snapshotsDir, fileName);
  if (options.element) {
    await options.element.screenshot({ path: filePath });
  } else if (options.clip) {
    await page.screenshot({ path: filePath, clip: options.clip });
  } else {
    await page.screenshot({ path: filePath, fullPage: true });
  }
  return filePath;
};

const captureFrames = async (page, scenario, theme, state, options = 4, gapMs = 80) => {
  // Backwards-compatible signature:
  // - captureFrames(page, scenario, theme, state, count?, gapMs?)
  // - captureFrames(page, scenario, theme, state, { count, gapMs, clip, element }?)
  const opts =
    typeof options === "number"
      ? { count: options, gapMs, clip: null, element: null }
      : { count: 4, gapMs: 80, clip: null, element: null, ...(options || {}) };

  const files = [];
  for (let i = 0; i < opts.count; i += 1) {
    const fileName = `${sanitize(scenario)}__${sanitize(theme)}__${sanitize(state)}__frame${i}.png`;
    const filePath = path.join(framesDir, fileName);
    if (opts.element) {
      await opts.element.screenshot({ path: filePath });
    } else if (opts.clip) {
      await page.screenshot({ path: filePath, clip: opts.clip });
    } else {
      await page.screenshot({ path: filePath, fullPage: true });
    }
    files.push(filePath);
    await page.waitForTimeout(opts.gapMs);
  }
  return files;
};

const waitForActionLoading = async (page, actionSelector, spinnerSelector, timeoutMs = 2500) => {
  const waitForSpinner = page
    .waitForFunction((sel) => !!document.querySelector(sel), spinnerSelector, { timeout: timeoutMs })
    .catch(() => null);
  const waitForLoading = page
    .waitForFunction(
      (sel) => {
        const node = document.querySelector(sel);
        return node?.getAttribute("data-qa-state") === "loading";
      },
      actionSelector,
      { timeout: timeoutMs }
    )
    .catch(() => null);
  await Promise.all([waitForSpinner, waitForLoading]);
};

const captureClipFramesAtTimes = async ({
  page,
  scenario,
  theme,
  statePrefix,
  clip,
  sampleTimes,
  probeSelector,
  probes
}) => {
  const start = Date.now();
  const framePaths = [];
  for (const ms of sampleTimes) {
    const remaining = ms - (Date.now() - start);
    if (remaining > 0) await page.waitForTimeout(remaining);
    const fileName = `${sanitize(scenario)}__${sanitize(theme)}__${sanitize(statePrefix)}__t${String(ms).padStart(3, "0")}ms.png`;
    const filePath = path.join(framesDir, fileName);
    const capturedAt = Date.now() - start;
    const transform = probeSelector
      ? await page.evaluate((sel) => {
          const node = document.querySelector(sel);
          if (!node) return null;
          return window.getComputedStyle(node).transform;
        }, probeSelector)
      : null;
    const probeRect = probeSelector
      ? await page.evaluate((sel) => {
          const node = document.querySelector(sel);
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }, probeSelector)
      : null;
    const probeValues = Array.isArray(probes) && probes.length
      ? await page.evaluate((items) => {
          const read = (item) => {
            if (!item || !item.selector || !item.property) return null;
            const node = document.querySelector(item.selector);
            if (!node) return null;
            const style = window.getComputedStyle(node);
            if (item.property === "--var") {
              return style.getPropertyValue(item.name || "").trim();
            }
            return style[item.property] ?? null;
          };
          return items.map((item) => ({ name: item.name, value: read(item) }));
        }, probes)
      : null;
    await page.screenshot({ path: filePath, clip });
    framePaths.push({
      ms,
      actualMs: Math.max(0, Math.round(capturedAt)),
      path: filePath,
      transform,
      rect: probeRect,
      probes: probeValues
    });
  }
  return framePaths;
};

const computeActivityMorphClip = async (page) => {
  const viewport = page.viewportSize();
  if (!viewport) return null;
  const pad = 24;
  const drawerWidth = Math.min(420, Math.round(viewport.width * 0.92));
  const drawerHeight = Math.min(Math.round(viewport.height * 0.64), 520);
  const x = Math.max(0, viewport.width - pad - drawerWidth - 16);
  const y = Math.max(0, viewport.height - pad - drawerHeight - 24);
  const width = Math.max(1, viewport.width - x);
  const height = Math.max(1, viewport.height - y);
  return { x, y, width, height };
};

const assertCenteredInViewport = async (page, selector, label, tolerancePx = 22) => {
  const viewport = page.viewportSize();
  if (!viewport) return;
  const locator = page.locator(selector).first();
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`${label} not visible`);
  }
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const targetX = viewport.width / 2;
  const targetY = viewport.height / 2;
  const dx = Math.abs(centerX - targetX);
  const dy = Math.abs(centerY - targetY);
  if (dx > tolerancePx || dy > tolerancePx) {
    throw new Error(`${label} not centered (dx=${dx.toFixed(1)} dy=${dy.toFixed(1)})`);
  }
};

const assertFooterClock = async (page) => {
  const clock = page.locator("[data-qa='qa:status:bottom-clock']").first();
  await clock.waitFor({ state: "visible", timeout: 4000 });
  const text = (await clock.innerText()).replace(/\s+/g, " ").trim();
  const match = text.match(/^(\d{2}:\d{2}:\d{2})\s+(UTC[+-]\d{2}(?::\d{2})?)$/);
  if (!match) {
    throw new Error(`Bottom clock text unexpected: ${JSON.stringify(text)}`);
  }
  const hour = Number(match[1].slice(0, 2));
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
    throw new Error(`Bottom clock hour out of range: ${JSON.stringify(match[1])}`);
  }

  const viewport = page.viewportSize();
  const clockBox = await clock.boundingBox();
  if (!viewport || !clockBox) return;
  const clockCenterX = clockBox.x + clockBox.width / 2;
  const dx = Math.abs(clockCenterX - viewport.width / 2);
  if (dx > 28) {
    throw new Error(`Bottom clock not centered (dx=${dx.toFixed(1)})`);
  }

  const activity = page.locator("[data-qa='qa:action:activity-fab']").first();
  const activityBox = await activity.boundingBox();
  if (!activityBox) return;
  const clockCenterY = clockBox.y + clockBox.height / 2;
  const activityCenterY = activityBox.y + activityBox.height / 2;
  const dy = Math.abs(clockCenterY - activityCenterY);
  if (dy > 6) {
    throw new Error(`Footer row items not aligned (dy=${dy.toFixed(1)})`);
  }
};

const assertBackdropBlurred = async (page, selector, label) => {
  const locator = page.locator(selector).first();
  if (!(await locator.count())) {
    throw new Error(`${label} not found`);
  }
  const blur = await locator.evaluate((el) => {
    const style = window.getComputedStyle(el);
    return style.backdropFilter || style.webkitBackdropFilter || "";
  });
  if (!blur || blur === "none" || !blur.includes("blur(")) {
    throw new Error(`${label} is not blurred (backdropFilter=${JSON.stringify(blur)})`);
  }
};

const setTheme = async (page, mode, scheme) => {
  await page.emulateMedia({
    ...(scheme ? { colorScheme: scheme } : {}),
    reducedMotion: "no-preference"
  });
  await page.evaluate((theme) => {
    const resolved =
      theme === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : theme;
    try {
      localStorage.setItem("theme", theme);
      localStorage.setItem("themePreference", theme);
    } catch {
      // ignore
    }
    document.documentElement.dataset.theme = resolved;
    window.__ui_check__?.setThemePreference?.(theme, theme === "system");
  }, mode);
  await page.waitForFunction(
    () => {
      const root = document.documentElement;
      return (
        !root.classList.contains("theme-vt") && !root.classList.contains("theme-transition")
      );
    },
    { timeout: 3000 }
  );
};

const assertInitOverlaySkeletonContrast = async (page, themeKey) =>
  page.evaluate((key) => {
    const overlay = document.querySelector("[data-qa='qa:overlay:init']");
    if (!overlay) {
      throw new Error("Init overlay not present");
    }
    const spans = Array.from(
      document.querySelectorAll("[data-qa='qa:card:init'] .status-skeleton span")
    );
    if (spans.length !== 3) {
      throw new Error(`Expected 3 skeleton lines, got ${spans.length}`);
    }
    const parseRgba = (value) => {
      const parts = value.match(/[\d.]+/g);
      if (!parts || parts.length < 3) return null;
      return {
        r: Number(parts[0]),
        g: Number(parts[1]),
        b: Number(parts[2]),
        a: parts[3] ? Number(parts[3]) : 1
      };
    };
    const bg = parseRgba(window.getComputedStyle(spans[0]).backgroundColor);
    if (!bg) {
      throw new Error("Unable to parse skeleton background color");
    }
    const isLight = key.includes("light");
    if (isLight) {
      if (bg.a < 0.1) throw new Error(`Skeleton alpha too low for light theme: ${bg.a}`);
      if (bg.r > 120 || bg.g > 120 || bg.b > 120) {
        throw new Error(
          `Skeleton color too bright for light theme: rgba(${bg.r},${bg.g},${bg.b},${bg.a})`
        );
      }
    } else {
      if (bg.a < 0.07) throw new Error(`Skeleton alpha too low for dark theme: ${bg.a}`);
      if (bg.r < 200 || bg.g < 200 || bg.b < 200) {
        throw new Error(
          `Skeleton color too dim for dark theme: rgba(${bg.r},${bg.g},${bg.b},${bg.a})`
        );
      }
    }
    return true;
  }, themeKey);

const injectDesktopBackend = async (page, mode, dispatchReadyEvent = true) =>
  page.evaluate(([themeMode, shouldDispatch]) => {
    // Test-only mock: the real app version is owned by the desktop backend (APP_VERSION).
    const snapshot = {
      lastPull: "Not yet",
      lastSync: "Not yet",
      lastPullAt: "",
      lastSyncAt: "",
      outputDir: "",
      repoPath: "",
      currency: "USD",
      currencyOptions: ["ALL", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"],
      pullActive: false,
      syncActive: false,
      restartInSeconds: 0,
      events: [
        {
          id: "evt-2026-01-05-0130-usd-cpi-yoy",
          state: "upcoming",
          time: "05-01-2026 01:30",
          cur: "USD",
          impact: "High",
          event: "CPI (YoY)",
          countdown: "18h 27m"
        },
        {
          id: "evt-2026-01-05-0200-usd-core-cpi-yoy",
          state: "upcoming",
          time: "05-01-2026 02:00",
          cur: "USD",
          impact: "High",
          event: "Core CPI (YoY)",
          countdown: "18h 57m"
        },
        {
          id: "evt-2026-01-05-0230-usd-fomc-statement",
          state: "upcoming",
          time: "05-01-2026 02:30",
          cur: "USD",
          impact: "High",
          event: "FOMC Statement",
          countdown: "19h 27m"
        },
        {
          id: "evt-2026-01-05-0300-usd-fed-press-conference",
          state: "upcoming",
          time: "05-01-2026 03:00",
          cur: "USD",
          impact: "High",
          event: "Fed Press Conference",
          countdown: "19h 57m"
        },
        {
          id: "evt-2026-01-05-0330-eur-ecb-minutes",
          state: "upcoming",
          time: "05-01-2026 03:30",
          cur: "EUR",
          impact: "Medium",
          event: "ECB Minutes",
          countdown: "20h 27m"
        },
        {
          id: "evt-2026-01-05-0400-gbp-retail-sales",
          state: "upcoming",
          time: "05-01-2026 04:00",
          cur: "GBP",
          impact: "Medium",
          event: "Retail Sales",
          countdown: "20h 57m"
        },
        {
          id: "evt-2026-01-05-0430-jpy-industrial-production",
          state: "upcoming",
          time: "05-01-2026 04:30",
          cur: "JPY",
          impact: "Medium",
          event: "Industrial Production",
          countdown: "21h 27m"
        },
        {
          id: "evt-2026-01-05-0500-aud-employment-change",
          state: "upcoming",
          time: "05-01-2026 05:00",
          cur: "AUD",
          impact: "Medium",
          event: "Employment Change",
          countdown: "21h 57m"
        },
        {
          id: "evt-2026-01-05-0530-usd-mba-mortgage-applications",
          state: "upcoming",
          time: "05-01-2026 05:30",
          cur: "USD",
          impact: "Low",
          event: "MBA Mortgage Applications",
          countdown: "22h 27m"
        },
        {
          id: "evt-2026-01-05-0600-eur-german-trade-balance",
          state: "upcoming",
          time: "05-01-2026 06:00",
          cur: "EUR",
          impact: "Low",
          event: "German Trade Balance",
          countdown: "22h 57m"
        },
        {
          id: "evt-2026-01-05-0630-gbp-uk-manufacturing-output",
          state: "upcoming",
          time: "05-01-2026 06:30",
          cur: "GBP",
          impact: "Low",
          event: "UK Manufacturing Output",
          countdown: "23h 27m"
        },
        {
          id: "evt-2026-01-05-0700-cad-housing-starts",
          state: "upcoming",
          time: "05-01-2026 07:00",
          cur: "CAD",
          impact: "Low",
          event: "Housing Starts",
          countdown: "23h 57m"
        }
      ],
      pastEvents: [
        { time: "04-01-2026 12:30", cur: "USD", impact: "High", event: "Nonfarm Payrolls", actual: "1.8", forecast: "--", previous: "1.2" },
        { time: "04-01-2026 14:00", cur: "USD", impact: "Medium", event: "ISM PMI", actual: "49.0", forecast: "--", previous: "49.0" },
        { time: "04-01-2026 16:00", cur: "USD", impact: "Low", event: "Jobless Claims", actual: "210K", forecast: "--", previous: "225K" }
      ],
      logs: [],
      version: "0.0.0"
    };

    const settings = {
      autoSyncAfterPull: true,
      autoUpdateEnabled: true,
      runOnStartup: true,
      debug: false,
      autoSave: true,
      enableSystemTheme: themeMode === "system",
      theme: themeMode,
      enableTemporaryPath: false,
      temporaryPath: "",
      repoPath: "",
      logPath: "",
      removeLogs: true,
      removeOutput: false,
      removeTemporaryPaths: true,
      uninstallConfirm: ""
    };

    const defaultUpdateState = () => ({
      ok: true,
      phase: "idle",
      message: "",
      availableVersion: "",
      progress: 0,
      lastCheckedAt: "05-01-2026 12:34"
    });

    const getUpdateState = () => window.__MOCK_UPDATE_STATE__ || defaultUpdateState();
    const setUpdateState = (next) => {
      window.__MOCK_UPDATE_STATE__ = { ...defaultUpdateState(), ...getUpdateState(), ...next };
      return window.__MOCK_UPDATE_STATE__;
    };

    const formatDisplayTime = (date) => {
      const pad = (value) => String(value).padStart(2, "0");
      return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(
        date.getHours()
      )}:${pad(date.getMinutes())}`;
    };

    const setSnapshot = (next) => {
      window.__desktop_snapshot__ = next;
      return next;
    };

    const normalizePathKey = (value) =>
      String(value || "")
        .trim()
        .replace(/[\\/]+$/, "")
        .toLowerCase();

    const getOutputLastSync = (outputDir) => {
      const key = normalizePathKey(outputDir);
      if (!key) return { lastSyncAt: "", lastSync: "Not yet" };
      const map = window.__MOCK_OUTPUT_LAST_SYNC__ || {};
      return map[key] || { lastSyncAt: "", lastSync: "Not yet" };
    };

    const setOutputLastSync = (outputDir, payload) => {
      const key = normalizePathKey(outputDir);
      if (!key) return;
      const map = window.__MOCK_OUTPUT_LAST_SYNC__ || {};
      map[key] = { ...getOutputLastSync(outputDir), ...payload };
      window.__MOCK_OUTPUT_LAST_SYNC__ = map;
    };

    window.pywebview = {
      api: {
        get_snapshot: () => Promise.resolve(window.__desktop_snapshot__),
        get_settings: () => Promise.resolve(settings),
        save_settings: () => Promise.resolve({ ok: true }),
        get_update_state: () => Promise.resolve(setUpdateState({})),
        check_updates: () => {
          setUpdateState({
            phase: "available",
            message: "Update available: 9.9.9",
            availableVersion: "9.9.9",
            progress: 0,
            lastCheckedAt: "05-01-2026 12:34"
          });
          return Promise.resolve({ ok: true });
        },
        update_now: () => {
          setUpdateState({
            phase: "downloading",
            message: "Downloading...",
            progress: 0,
            lastCheckedAt: "05-01-2026 12:34"
          });
          return Promise.resolve({ ok: true });
        },
        open_log: () => Promise.resolve({ ok: true }),
        open_path: () => Promise.resolve({ ok: true }),
        add_log: () => Promise.resolve({ ok: true }),
        browse_temporary_path: () => Promise.resolve({ ok: true, path: "" }),
        set_temporary_path: () => Promise.resolve({ ok: true }),
        uninstall: () => Promise.resolve({ ok: true }),
        pull_now: () => {
          const startedAt = formatDisplayTime(new Date());
          const baseline = window.__desktop_snapshot__;
          setSnapshot({
            ...baseline,
            pullActive: true,
            logs: [{ time: startedAt, message: "Manual pull started", level: "INFO" }, ...(baseline.logs || [])]
          });
          window.setTimeout(() => {
            const finishedAt = formatDisplayTime(new Date());
            const current = window.__desktop_snapshot__;
            setSnapshot({
              ...current,
              pullActive: false,
              lastPullAt: new Date().toISOString(),
              lastPull: finishedAt,
              logs: [
                { time: finishedAt, message: "Data update completed", level: "INFO" },
                ...(current.logs || [])
              ]
            });
          }, 450);
          return Promise.resolve({ ok: true });
        },
        sync_now: () => {
          const startedAt = formatDisplayTime(new Date());
          const baseline = window.__desktop_snapshot__;
          setSnapshot({
            ...baseline,
            syncActive: true,
            logs: [{ time: startedAt, message: "Manual sync started", level: "INFO" }, ...(baseline.logs || [])]
          });
          window.setTimeout(() => {
            const finishedAt = formatDisplayTime(new Date());
            const current = window.__desktop_snapshot__;
            const outputDir = String(current.outputDir || "").trim();
            if (!outputDir) {
              setSnapshot({
                ...current,
                syncActive: false,
                logs: [{ time: finishedAt, message: "Sync skipped (no output dir)", level: "WARN" }, ...(current.logs || [])]
              });
              return;
            }
            const lastSyncAt = new Date().toISOString();
            setOutputLastSync(outputDir, { lastSyncAt, lastSync: finishedAt });
            setSnapshot({
              ...current,
              syncActive: false,
              lastSyncAt,
              lastSync: finishedAt,
              logs: [{ time: finishedAt, message: "Sync completed", level: "INFO" }, ...(current.logs || [])]
            });
          }, 450);
          return Promise.resolve({ ok: true });
        },
        browse_output_dir: () => Promise.resolve({ ok: true, path: "" }),
        set_output_dir: (path) => {
          const value = typeof path === "string" ? path : "";
          const baseline = window.__desktop_snapshot__;
          const outputSync = value ? getOutputLastSync(value) : { lastSyncAt: "", lastSync: "Not yet" };
          setSnapshot({
            ...baseline,
            outputDir: value,
            lastSyncAt: outputSync.lastSyncAt,
            lastSync: outputSync.lastSync
          });
          return Promise.resolve({ ok: true });
        },
        set_currency: () => Promise.resolve({ ok: true }),
        clear_logs: () => Promise.resolve({ ok: true })
      }
    };
    window.__desktop_snapshot__ = snapshot;
    if (shouldDispatch) {
      window.dispatchEvent(new Event("pywebviewready"));
    }
    return true;
  }, [mode, dispatchReadyEvent]);

const runCurrentTimelineDemo = async (page) => {
  // Visible timeline for the theme video: multiple "Current" items, reorder to top,
  // then the oldest current disappears from Next Events and appears in History.
  const nextCard = page.locator("[data-qa='qa:card:next-events']").first();
  const historyCard = page.locator("[data-qa='qa:card:history']").first();
  if ((await nextCard.count()) === 0 || (await historyCard.count()) === 0) return;

  const wait = async (ms) => page.waitForTimeout(ms);
  const waitForNoFlipAnim = async (ms = 520) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      const count = await page.evaluate(
        () => document.querySelectorAll("[data-qa='qa:row:next-event'][data-flip-anim]").length
      );
      if (count) {
        throw new Error(`Unexpected Next Events FLIP animation detected (${count})`);
      }
      await wait(60);
    }
  };
  const waitForFlipAnim = async (ms = 520) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      const count = await page.evaluate(
        () => document.querySelectorAll("[data-qa='qa:row:next-event'][data-flip-anim]").length
      );
      if (count) return;
      await wait(40);
    }
    throw new Error("Expected Next Events FLIP animation, but none was detected");
  };

  const setSnapshot = async (payload) => {
    await page.evaluate((next) => {
      const snap = window.__desktop_snapshot__ || {};
      window.__desktop_snapshot__ = { ...snap, ...next };
    }, payload);
    await page.evaluate(() => window.__ui_check__?.refresh?.());
  };

  const baseDate = await page.evaluate(() => {
    const pad = (value) => String(value).padStart(2, "0");
    const date = new Date();
    return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
  });

  const mk = (id, clock, name, impact, cur = "USD") => ({
    id,
    time: `${baseDate} ${clock}`,
    cur,
    impact,
    event: name,
    countdown: "12m",
    state: "upcoming"
  });

  const evtA = mk("demo-current-a", "09:00", "Current demo A", "High");
  // Same scheduled time as A: turning this into Current should not cause reorder animation.
  const evtB = mk("demo-current-b", "09:00", "Current demo B", "Medium");
  // > 1 minute later: this becoming Current should slide to the top.
  const evtC = mk("demo-current-c", "09:02", "Current demo C", "High");
  const evtD = mk("demo-current-d", "09:10", "Current demo D", "Low");
  const evtE = mk("demo-current-e", "09:20", "Current demo E", "Low");

  // Baseline: upcoming events only (no Current/soon-Current).
  await setSnapshot({ events: [evtA, evtB, evtC, evtD, evtE], pastEvents: [] });
  await wait(900);

  // Impact filter toggles must not trigger "slide" animations when no Current/soon items exist.
  const activeImpactToggles = page.locator("button.impact-toggle.active");
  while (await activeImpactToggles.count()) {
    await activeImpactToggles.first().click();
    await wait(120);
  }
  await waitForNoFlipAnim();

  const impactButtons = page.locator("[data-qa='qa:filter:impact'] button.impact-toggle");
  if ((await impactButtons.count()) >= 3) {
    // Toggle L, M, H and ensure we never animate row shuffles.
    await impactButtons.nth(0).click();
    await wait(220);
    await waitForNoFlipAnim();
    await impactButtons.nth(1).click();
    await wait(220);
    await waitForNoFlipAnim();
    await impactButtons.nth(2).click();
    await wait(220);
    await waitForNoFlipAnim();

    // Reset back to no filter for the Current sequence.
    while (await activeImpactToggles.count()) {
      await activeImpactToggles.first().click();
      await wait(120);
    }
    await waitForNoFlipAnim();
  }

  // A becomes Current (B shares the same time, but stays upcoming).
  await setSnapshot({
    events: [
      { ...evtA, state: "current", countdown: "Current" },
      { ...evtB, state: "upcoming", countdown: "12m" },
      { ...evtC, state: "upcoming", countdown: "2m" },
      { ...evtD, state: "upcoming", countdown: "1h 00m" },
      { ...evtE, state: "upcoming", countdown: "2h 00m" }
    ]
  });
  await wait(1300);

  // B becomes Current at the same scheduled time as A: do NOT animate reorder shuffles.
  await setSnapshot({
    events: [
      { ...evtA, state: "current", countdown: "Current" },
      { ...evtB, state: "current", countdown: "Current" },
      { ...evtC, state: "upcoming", countdown: "2m" },
      { ...evtD, state: "upcoming", countdown: "1h 00m" },
      { ...evtE, state: "upcoming", countdown: "2h 00m" }
    ]
  });
  await wait(800);
  await waitForNoFlipAnim();
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => window.setTimeout(r, ms));
    const getImpactOpacity = (row) => {
      const impact = row.querySelector(".event-impact");
      if (!(impact instanceof HTMLElement)) return null;
      const after = window.getComputedStyle(impact, "::after");
      const opacity = Number.parseFloat(after.opacity || "0");
      return Number.isFinite(opacity) ? opacity : null;
    };

    const rows = Array.from(
      document.querySelectorAll("[data-qa='qa:row:next-event'].current")
    );
    if (rows.length < 2) throw new Error(`Expected >=2 current rows, got ${rows.length}`);

    // The stored delays can differ (because they were applied at different times),
    // but the *pulse phase* should be in sync. Sample over ~1 cycle and validate
    // both rows match when the pulse is visible.
    const maxWindowMs = 2300;
    const stepMs = 60;
    const threshold = 0.08;
    const diffTolerance = 0.08;

    let sawPulse = false;
    for (let elapsed = 0; elapsed < maxWindowMs; elapsed += stepMs) {
      const a = getImpactOpacity(rows[0]);
      const b = getImpactOpacity(rows[1]);
      if (a === null || b === null) throw new Error("Unable to read pulse opacity");

      const peak = Math.max(a, b);
      if (peak >= threshold) {
        sawPulse = true;
        const diff = Math.abs(a - b);
        if (diff > diffTolerance) {
          throw new Error(`Pulse out of sync (opacity A=${a.toFixed(3)} B=${b.toFixed(3)})`);
        }
        break;
      }
      await sleep(stepMs);
    }

    if (!sawPulse) {
      // Non-fatal-ish, but we want a deterministic check in CI.
      throw new Error("Unable to sample a visible pulse within one cycle");
    }
  });

  // C becomes Current (> 1 minute later) and slides to the top.
  // D is "soon current" (1m) and is also allowed to animate movement.
  await setSnapshot({
    events: [
      { ...evtC, state: "current", countdown: "Current" },
      { ...evtA, state: "current", countdown: "Current" },
      { ...evtB, state: "current", countdown: "Current" },
      { ...evtD, state: "upcoming", countdown: "1m" },
      { ...evtE, state: "upcoming", countdown: "2h 00m" }
    ]
  });
  const allowedFlipIds = new Set([
    "demo-current-a",
    "demo-current-b",
    "demo-current-c",
    "demo-current-d"
  ]);
  await waitForFlipAnim();
  await page.waitForTimeout(60);
  await page.evaluate((allowed) => {
    const active = Array.from(
      document.querySelectorAll("[data-qa='qa:row:next-event'][data-flip-anim]")
    )
      .map((node) => node.getAttribute("data-qa-row-id") || "")
      .filter(Boolean);

    if (!active.length) {
      throw new Error("Expected at least one FLIP row during current demo, found none");
    }

    const unexpected = active.filter((id) => !allowed.includes(id));
    if (unexpected.length) {
      throw new Error(`Unexpected FLIP rows during current demo: ${unexpected.join(", ")}`);
    }
  }, Array.from(allowedFlipIds));
  await wait(1400);

  // Simulate "3 minutes later": oldest current (B at the bottom) moves to History.
  await setSnapshot({
    events: [
      { ...evtC, state: "current", countdown: "Current" },
      { ...evtA, state: "current", countdown: "Current" },
      { ...evtD, state: "upcoming", countdown: "59m" },
      { ...evtE, state: "upcoming", countdown: "1h 59m" }
    ],
    pastEvents: [
      {
        time: `${baseDate} 09:00`,
        cur: "USD",
        impact: "High",
        event: "Current demo B",
        actual: "--",
        forecast: "--",
        previous: "--"
      }
    ]
  });
  await wait(2200);
};

const pressElement = async (page, locator) => {
  // Hold :active without triggering a click. Caller should `await release()` after
  // taking a screenshot, then perform an explicit click once.
  const box = await locator.boundingBox();
  if (!box) return async () => {};

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();

  return async () => {
    // Releasing outside the element avoids generating an implicit click.
    await page.mouse.move(cx, cy + Math.max(24, box.height));
    await page.mouse.up();
  };
};

const readActionButtonState = async (page, selector) =>
  page.evaluate((sel) => {
    const btn = document.querySelector(sel);
    const state = (btn?.getAttribute("data-qa-state") || "").trim();
    const label = (btn?.textContent || "").trim();
    const toasts = Array.from(document.querySelectorAll(".toast")).map((node) => {
      const text = (node.textContent || "").trim();
      const type =
        node.classList.contains("success") ||
        node.getAttribute("data-type") === "success"
          ? "success"
          : node.classList.contains("error") ||
              node.getAttribute("data-type") === "error"
            ? "error"
            : "info";
      return { type, text };
    });
    return { state, label, toasts };
  }, selector);

const waitForActionCompletion = async (
  page,
  selector,
  { timeoutMs = 6000, minIdleMs = 400 } = {}
) => {
  const start = Date.now();
  let last = await readActionButtonState(page, selector);
  let sawNonIdle = last.state && last.state !== "idle";

  // Wait until the state machine settles into a terminal state. We treat both
  // success and error as terminal; idle is considered terminal too because the
  // UI auto-resets after the brief success/error flash.
  while (Date.now() - start < timeoutMs) {
    last = await readActionButtonState(page, selector);
    if (last.state && last.state !== "idle") {
      sawNonIdle = true;
    }
    if (["success", "error"].includes(last.state)) {
      return { ...last, timedOut: false };
    }
    if (last.state === "idle" && sawNonIdle && Date.now() - start >= minIdleMs) {
      return { ...last, timedOut: false };
    }
    await page.waitForTimeout(90);
  }

  last = await readActionButtonState(page, selector);
  return { ...last, timedOut: true };
};

const assertDropdownStableOnHover = async (page, trigger, name) => {
  const menu = page.locator(".select-menu").first();
  const before = await menu.boundingBox();
  if (!before) {
    throw new Error(`Dropdown menu missing before hover for ${name}`);
  }
  const cardBox = await trigger.evaluate((el) => {
    const card = el.closest(".card");
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  if (cardBox) {
    await page.mouse.move(
      cardBox.x + cardBox.width / 2,
      cardBox.y + Math.min(40, cardBox.height / 2)
    );
    await page.waitForTimeout(120);
  }
  const after = await menu.boundingBox();
  if (!after) {
    throw new Error(`Dropdown menu missing after hover for ${name}`);
  }
  const delta =
    Math.max(Math.abs(before.x - after.x), Math.abs(before.y - after.y)) || 0;
  if (delta > 2) {
    throw new Error(`Dropdown moved on hover (${name}): ${delta.toFixed(1)}px`);
  }
};

const assertThemeToggle = async (page) => {
  const before = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    mode: document
      .querySelector("[data-qa*='qa:action:theme']")
      ?.getAttribute("data-theme-mode")
  }));
  const toggle = page.locator("[data-qa*='qa:action:theme']").first();
  if (await toggle.count()) {
    await page.evaluate(() => {
      const btn = document.querySelector("[data-qa*='qa:action:theme']");
      btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }
  await page.waitForFunction(
    ({ theme, mode }) => {
      const nextTheme = document.documentElement.dataset.theme;
      const nextMode = document
        .querySelector("[data-qa*='qa:action:theme']")
        ?.getAttribute("data-theme-mode");
      return nextTheme !== theme || nextMode !== mode;
    },
    before,
    { timeout: 1000 }
  );
  const after = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    mode: document
      .querySelector("[data-qa*='qa:action:theme']")
      ?.getAttribute("data-theme-mode")
  }));
  if (before.theme === after.theme && before.mode === after.mode) {
    throw new Error("Theme toggle did not change theme or mode");
  }
};

const assertThemeTransitionSynchronized = async (page, themeKey) => {
  await page.waitForFunction(
    () => ["dark", "light"].includes(document.documentElement.dataset.theme || ""),
    { timeout: 1000 }
  );
  const parseCssDurationMs = (value) => {
    const trimmed = String(value || "").trim();
    if (!trimmed) return null;
    if (trimmed.endsWith("ms")) {
      const ms = Number(trimmed.slice(0, -2));
      return Number.isFinite(ms) ? ms : null;
    }
    if (trimmed.endsWith("s")) {
      const s = Number(trimmed.slice(0, -1));
      return Number.isFinite(s) ? s * 1000 : null;
    }
    const ms = Number(trimmed);
    return Number.isFinite(ms) ? ms : null;
  };
  const beforeThemeShot = path.join(
    framesDir,
    `${sanitize("theme-transition")}__${sanitize(themeKey)}__before.png`
  );
  const beforeInfo = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    bg: window.getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
    panel: window.getComputedStyle(document.documentElement).getPropertyValue("--panel").trim()
  }));
  await page.screenshot({ path: beforeThemeShot });

  const startTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  const desiredTheme = startTheme === "dark" ? "light" : "dark";
  const supportsViewTransition = await page.evaluate(
    () => typeof document.startViewTransition === "function"
  );

  await page.evaluate((theme) => {
    window.__ui_check__?.setThemePreference?.(theme, false);
  }, startTheme);
  await page.waitForTimeout(120);

  const themeDurationRaw = await page.evaluate(() =>
    window.getComputedStyle(document.documentElement).getPropertyValue("--theme-duration")
  );
  const durationMsFallback = 950;
  const durationMsParsed = parseCssDurationMs(themeDurationRaw);
  const durationMs =
    durationMsParsed !== null && durationMsParsed >= 200 && durationMsParsed <= 4000
      ? durationMsParsed
      : durationMsFallback;

  await page.waitForFunction(() => !!window.__ui_check__, null, { timeout: 4000 });
  const start = Date.now();
  const toggled = await page.evaluate(() => {
    if (window.__ui_check__?.toggleTheme) {
      window.__ui_check__.toggleTheme();
      return true;
    }
    const btn = document.querySelector("[data-qa*='qa:action:theme']");
    if (!btn) return false;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  if (!toggled) {
    throw new Error("Theme toggle trigger missing");
  }

  await page.waitForFunction(
    (targetTheme) => document.documentElement.dataset.theme === targetTheme,
    desiredTheme,
    { timeout: durationMs + 2000 }
  );
  const flipStart = Date.now();

  await page
    .waitForFunction(
      () =>
        document.documentElement.classList.contains("theme-transition") ||
        document.documentElement.classList.contains("theme-vt"),
      null,
      { timeout: durationMs + 800 }
    )
    .catch(() => null);

  // Give the UI a moment to apply theme transition origin vars before sampling.
  await page.waitForTimeout(16);
  const origin = await page.evaluate(() => {
    const root = document.documentElement;
    const style = window.getComputedStyle(root);
    const dpr = window.devicePixelRatio || 1;
    const parse = (value, size) => {
      const raw = String(value || "").trim();
      if (!raw) return null;
      if (raw.endsWith("px")) {
        const px = Number.parseFloat(raw.slice(0, -2));
        return Number.isFinite(px) ? px : null;
      }
      if (raw.endsWith("%")) {
        const pct = Number.parseFloat(raw.slice(0, -1));
        return Number.isFinite(pct) ? (pct / 100) * size : null;
      }
      const px = Number.parseFloat(raw);
      return Number.isFinite(px) ? px : null;
    };
    const x =
      parse(style.getPropertyValue("--theme-vt-x"), window.innerWidth) ?? window.innerWidth / 2;
    const y =
      parse(style.getPropertyValue("--theme-vt-y"), window.innerHeight) ?? window.innerHeight / 2;
    return { x: x * dpr, y: y * dpr };
  });

  const waitFromFlip = async (ms) => {
    const remaining = ms - (Date.now() - flipStart);
    if (remaining > 0) await page.waitForTimeout(remaining);
  };

  // Keep the report lightweight: we only need a few early frames to confirm the
  // transition starts, plus a couple of mid/late frames to prove it progresses
  // and is not instantaneous.
  const denseEarly = [0, 24, 48, 72];
  const midFractions = [0.5, 0.9].map((t) => Math.round(durationMs * t));
  const sampleTimes = Array.from(new Set([...denseEarly, ...midFractions]))
    .filter((ms) => ms >= 0 && ms <= durationMs)
    .sort((a, b) => a - b);
  const framePaths = [];
  for (const ms of sampleTimes) {
    await waitFromFlip(ms);
    const fileName = `${sanitize("theme-transition")}__${sanitize(themeKey)}__t${String(ms).padStart(3, "0")}ms.png`;
    const filePath = path.join(framesDir, fileName);
    const capturedAt = Date.now() - start;
    await page.screenshot({ path: filePath });
    framePaths.push({ ms, actualMs: Math.max(0, Math.round(capturedAt)), path: filePath });
  }

  await waitFromFlip(Math.round(durationMs + Math.min(380, durationMs * 0.35)));
  const afterThemeShot = path.join(
    framesDir,
    `${sanitize("theme-transition")}__${sanitize(themeKey)}__after.png`
  );
  const afterInfo = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    bg: window.getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
    panel: window.getComputedStyle(document.documentElement).getPropertyValue("--panel").trim()
  }));
  await page.screenshot({ path: afterThemeShot });

  const readPng = async (filePath) => PNG.sync.read(await fs.readFile(filePath));
  const pixelAt = (png, x, y) => {
    const ix = Math.max(0, Math.min(png.width - 1, Math.round(x)));
    const iy = Math.max(0, Math.min(png.height - 1, Math.round(y)));
    const offset = (iy * png.width + ix) * 4;
    return [png.data[offset], png.data[offset + 1], png.data[offset + 2], png.data[offset + 3]];
  };
  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

  const startPng = await readPng(beforeThemeShot);
  const endPng = await readPng(afterThemeShot);
  const width = Math.min(startPng.width, endPng.width);
  const height = Math.min(startPng.height, endPng.height);

  const points = [];
  const cols = 10;
  const rows = 7;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const u = (col + 0.5) / cols;
      const v = (row + 0.5) / rows;
      const x = (0.12 + u * 0.76) * width;
      const y = (0.12 + v * 0.78) * height;
      const denom = dist(pixelAt(startPng, x, y), pixelAt(endPng, x, y));
      if (denom >= 18) {
        points.push({
          x,
          y,
          denom,
          d: Math.hypot(x - origin.x, y - origin.y)
        });
      }
    }
  }

  if (points.length < 26) {
    throw new Error(
      `Theme transition probe too small (points=${points.length}, before=${JSON.stringify(
        beforeInfo
      )}, after=${JSON.stringify(afterInfo)})`
    );
  }

  const orderedPoints = points.slice().sort((a, b) => a.d - b.d);
  const metrics = [];

  for (const frame of framePaths) {
    const framePng = await readPng(frame.path);
    const progresses = orderedPoints.map((point) => {
      const cur = dist(pixelAt(startPng, point.x, point.y), pixelAt(framePng, point.x, point.y));
      const value = point.denom ? cur / point.denom : 0;
      return Math.max(0, Math.min(1, value));
    });

    const avg = progresses.reduce((sum, value) => sum + value, 0) / progresses.length;
    const t = frame.actualMs ?? frame.ms;
    metrics.push({ t, avg });

    if (!supportsViewTransition) {
      const nearStart = progresses.filter((value) => value <= 0.12).length / progresses.length;
      const nearEnd = progresses.filter((value) => value >= 0.88).length / progresses.length;
      const wipeLike = nearStart >= 0.18 && nearEnd >= 0.18;

      const inWindow = t >= Math.round(durationMs * 0.08) && t <= Math.round(durationMs * 0.95);
      if (wipeLike && inWindow) {
        const states = progresses
          .map((value) => (value <= 0.12 ? -1 : value >= 0.88 ? 1 : 0))
          .filter((state) => state !== 0);
        if (states.length >= 8) {
          let flips = 0;
          for (let i = 1; i < states.length; i += 1) {
            if (states[i] !== states[i - 1]) flips += 1;
          }
          if (flips > 1) {
            throw new Error(`Theme transition island detected at t=${t}ms (flips=${flips})`);
          }
        }
      }
    }
  }

  const nearest = (target) =>
    metrics.reduce(
      (best, cur) => (Math.abs(cur.t - target) < Math.abs(best.t - target) ? cur : best),
      metrics[0]
    );

  const avgMid = nearest(Math.round(durationMs * 0.5))?.avg ?? 0;
  if (avgMid < 0.03) {
    await page.waitForTimeout(120);
    const retryPath = path.join(
      framesDir,
      `${sanitize("theme-transition")}__${sanitize(themeKey)}__retry.png`
    );
    await page.screenshot({ path: retryPath });
    const retryPng = await readPng(retryPath);
    const retryProgresses = orderedPoints.map((point) => {
      const cur = dist(pixelAt(startPng, point.x, point.y), pixelAt(retryPng, point.x, point.y));
      const value = point.denom ? cur / point.denom : 0;
      return Math.max(0, Math.min(1, value));
    });
    const retryAvg =
      retryProgresses.reduce((sum, value) => sum + value, 0) / retryProgresses.length;
    if (retryAvg < 0.03) {
      throw new Error(
        `Theme transition shows no mid-flight progress (avg@50%=${avgMid.toFixed(2)}, retry=${retryAvg.toFixed(2)})`
      );
    }
  }

  const doneAt = metrics.find((m) => m.avg >= 0.97)?.t ?? null;
  const earliestOk = Math.round(durationMs * 0.55) - 80;
  if (doneAt !== null && doneAt < earliestOk) {
    throw new Error(
      `Theme transition finishes too early (avg>=0.97 at ${doneAt}ms, expected >=${earliestOk}ms)`
    );
  }

  const clipTopDiff = async (aPath, bPath, clipHeight = 720) => {
    const aPng = PNG.sync.read(await fs.readFile(aPath));
    const bPng = PNG.sync.read(await fs.readFile(bPath));
    const width = Math.min(aPng.width, bPng.width);
    const height = Math.min(aPng.height, bPng.height, clipHeight);
    const aCrop = new PNG({ width, height });
    const bCrop = new PNG({ width, height });
    PNG.bitblt(aPng, aCrop, 0, 0, width, height, 0, 0);
    PNG.bitblt(bPng, bCrop, 0, 0, width, height, 0, 0);

    let sum = 0;
    for (let i = 0; i < aCrop.data.length; i += 4) {
      sum += Math.abs(aCrop.data[i] - bCrop.data[i]);
      sum += Math.abs(aCrop.data[i + 1] - bCrop.data[i + 1]);
      sum += Math.abs(aCrop.data[i + 2] - bCrop.data[i + 2]);
    }
    const denom = width * height * 3 * 255;
    const mad = denom ? sum / denom : 0;
    return { mad };
  };

  const ordered = framePaths
    .slice()
    .sort((a, b) => (a.actualMs ?? a.ms) - (b.actualMs ?? b.ms));
  const ratios = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    const { mad } = await clipTopDiff(prev.path, cur.path);
    ratios.push({ from: prev.actualMs ?? prev.ms, to: cur.actualMs ?? cur.ms, mad });
  }

  const significant = ratios.filter((r) => r.mad > 0.0012);
  if (significant.length < 2) {
    throw new Error(
      `Theme transition looks instantaneous in screenshots (sigFrames=${significant.length}, mads=${ratios
        .map((r) => r.mad.toFixed(4))
        .join(", ")})`
    );
  }

  const lastSig = significant[significant.length - 1];
  if (lastSig.to < Math.round(durationMs * 0.45)) {
    throw new Error(
      `Theme transition finishes too early in screenshots (lastChange=${lastSig.to}ms, duration=${durationMs}ms)`
    );
  }

  return framePaths;
};

const main = async () => {
  const allThemes = [
    { key: "dark", mode: "dark" },
    { key: "light", mode: "light" },
    { key: "system-dark", mode: "system", scheme: "dark" },
    { key: "system-light", mode: "system", scheme: "light" }
  ];
  const requestedTheme = process.env.UI_CHECK_THEME;
  const themes = requestedTheme
    ? allThemes.filter((theme) => theme.key === requestedTheme)
    : allThemes;

  if (requestedTheme && themes.length === 0) {
    throw new Error(`Unknown UI_CHECK_THEME: ${requestedTheme}`);
  }

  const runIsolatedThemes = async (themeList) => {
    const baseArtifactsRoot = process.env.UI_CHECK_OUTPUT_DIR
      ? path.resolve(process.env.UI_CHECK_OUTPUT_DIR)
      : path.resolve(repoRoot, "app", "tests-ui", "artifacts", "ui-check");
    const baseReportPath = path.join(baseArtifactsRoot, "report.html");
    await ensureDir(baseArtifactsRoot);
    await clearDir(baseArtifactsRoot);
    await fs.rm(baseReportPath, { force: true });

    const workerLimit = parseWorkerLimit(process.env.UI_CHECK_WORKERS) ?? themeList.length;
    const workerCount = Math.max(1, Math.min(themeList.length, workerLimit));
    const basePort = parsePort(process.env.UI_CHECK_PORT_BASE) ?? defaultPort;

    const jobs = themeList.map((theme, index) => ({ theme, index }));
    const errors = await runWithPool(jobs, workerCount, async ({ theme, index }) => {
      await new Promise((resolve, reject) => {
        const port = basePort + index * 10;
        const childEnv = {
          ...process.env,
          UI_CHECK_THEME: theme.key,
          UI_CHECK_OUTPUT_TAG: theme.key,
          UI_CHECK_WORKERS: "1",
          UI_CHECK_SKIP_REPORT: "1",
          UI_CHECK_PORT: String(port)
        };
        if (process.env.UI_CHECK_OUTPUT_DIR) {
          childEnv.UI_CHECK_OUTPUT_DIR = path.join(baseArtifactsRoot, theme.key);
        }
        const child = spawn("node", [path.join(__dirname, "ui-check.mjs")], {
          cwd: repoRoot,
          stdio: "inherit",
          env: childEnv
        });
        child.on("exit", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`ui-check child failed (${theme.key}) exit=${code}`));
          }
        });
      });
    });

    const manifests = [];
    for (const theme of themeList) {
      const manifestPath = path.join(baseArtifactsRoot, theme.key, "manifest.json");
      try {
        const data = await fs.readFile(manifestPath, "utf-8");
        manifests.push(JSON.parse(data));
      } catch (err) {
        console.warn(`WARN ui-check manifest missing for ${theme.key}: ${err?.message || err}`);
      }
    }

    const mergedArtifacts = manifests.flatMap((m) => m?.artifacts || []);
    const mergedVideos = manifests.flatMap((m) => m?.videos || []);
    await generateReport(mergedArtifacts, mergedVideos, {
      artifactsRoot: baseArtifactsRoot,
      reportPath: baseReportPath
    });

    const mergedChecks = manifests.flatMap((m) => m?.checkResults || []);
    const summary = mergedChecks.reduce(
      (acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      },
      {}
    );
    console.log("UI-CHECK SUMMARY", summary);

    if (errors.length) {
      const failedThemes = errors
        .map(({ item }) => item?.theme?.key || "unknown")
        .filter(Boolean)
        .join(", ");
      throw new Error(`UI-CHECK THEMES FAILED: ${failedThemes}`);
    }
  };

  const useIsolated =
    !requestedTheme && (process.env.UI_CHECK_ISOLATED || "").trim().toLowerCase() !== "0";
  if (useIsolated) {
    await runIsolatedThemes(themes);
    return;
  }

  await ensureDir(artifactsRoot);
  await ensureDir(snapshotsDir);
  await ensureDir(framesDir);
  await ensureDir(videoDir);
  await clearDir(snapshotsDir);
  await clearDir(framesDir);
  await clearDir(videoDir);
  await fs.rm(reportPath, { force: true });

  const checkResults = [];
  const runCheck = async (themeKey, name, fn) => {
    try {
      await fn();
      checkResults.push({ theme: themeKey, name, status: "PASS" });
      console.log(`PASS [${themeKey}] ${name}`);
    } catch (err) {
      checkResults.push({ theme: themeKey, name, status: "FAIL", error: err?.message });
      console.error(`FAIL [${themeKey}] ${name}: ${err?.message || err}`);
      throw err;
    }
  };
  const skipCheck = (themeKey, name, reason) => {
    checkResults.push({ theme: themeKey, name, status: "SKIP", error: reason });
    console.log(`SKIP [${themeKey}] ${name}: ${reason}`);
  };

  const sampleTransition = async (page, selector, samples = 4, gapMs = 60) => {
    const values = [];
    for (let i = 0; i < samples; i += 1) {
      const entry = await page.evaluate((sel) => {
        const node = document.querySelector(sel);
        if (!node) return null;
        const style = window.getComputedStyle(node);
        return { opacity: Number(style.opacity), transform: style.transform };
      }, selector);
      values.push(entry);
      await page.waitForTimeout(gapMs);
    }
    const valid = values.filter(Boolean);
    const opacities = valid.map((v) => v.opacity);
    const transforms = valid.map((v) => v.transform);
    const changed =
      new Set(opacities.map((v) => String(v))).size > 1 ||
      new Set(transforms).size > 1;
    return { values: valid, changed };
  };

  const measureModalScroll = async (page) =>
    page.evaluate(() => {
      const body = document.querySelector("[data-qa*='qa:modal-body:settings']");
      const outerBefore = document.documentElement.scrollTop || document.body.scrollTop;
      const modalBefore = body ? body.scrollTop : 0;
      if (body) {
        body.scrollTop = 0;
      }
      const outerAfter = document.documentElement.scrollTop || document.body.scrollTop;
      if (body) {
        body.scrollTop = Math.min(120, body.scrollHeight);
      }
      const modalAfter = body ? body.scrollTop : 0;
      return { outerBefore, outerAfter, modalBefore, modalAfter };
    });

  const measureAutosaveShift = async (page) => {
    const before = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll(".modal-subtitle, .modal-header *, .section-title")
      );
      return nodes.slice(0, 12).map((node) => {
        const rect = node.getBoundingClientRect();
        return { top: rect.top, left: rect.left };
      });
    });
    const wasChecked = await page.evaluate(() => {
      const input = document.querySelector(
        "[data-qa*='qa:control:auto-update-enabled'] input[type='checkbox']"
      );
      return input ? input.checked : false;
    });
    await page.evaluate(() => {
      const input = document.querySelector(
        "[data-qa*='qa:control:auto-update-enabled'] input[type='checkbox']"
      );
      if (!input) return false;
      input.checked = !input.checked;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    });
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll(".modal-subtitle, .modal-header *, .section-title")
      );
      return nodes.slice(0, 12).map((node) => {
        const rect = node.getBoundingClientRect();
        return { top: rect.top, left: rect.left };
      });
    });
    await page.evaluate((checked) => {
      const input = document.querySelector(
        "[data-qa*='qa:control:auto-update-enabled'] input[type='checkbox']"
      );
      if (!input) return;
      if (input.checked !== checked) {
        input.checked = checked;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, wasChecked);
    let maxDelta = 0;
    for (let i = 0; i < Math.min(before.length, after.length); i += 1) {
      const delta = Math.abs(after[i].top - before[i].top);
      if (delta > maxDelta) maxDelta = delta;
    }
    return maxDelta;
  };

  const measureSelectVisibility = async (page) =>
    page.evaluate(() => {
      const toRgb = (value) => {
        const parts = value.match(/[\d.]+/g);
        if (!parts || parts.length < 3) return [0, 0, 0, 0];
        return [
          Number(parts[0]),
          Number(parts[1]),
          Number(parts[2]),
          parts[3] ? Number(parts[3]) : 1
        ];
      };
      const luminance = (r, g, b) => {
        const srgb = [r, g, b].map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
      };
      const contrast = (fg, bg) => {
        const l1 = luminance(fg[0], fg[1], fg[2]);
        const l2 = luminance(bg[0], bg[1], bg[2]);
        const bright = Math.max(l1, l2);
        const dark = Math.min(l1, l2);
        return (bright + 0.05) / (dark + 0.05);
      };
      const trigger = document.querySelector(".select-trigger");
      if (!trigger) return null;
      const caret = trigger.querySelector(".select-caret");
      const triggerStyle = window.getComputedStyle(trigger);
      const caretStyle = caret ? window.getComputedStyle(caret) : null;
      const bg = toRgb(triggerStyle.backgroundColor);
      const border = toRgb(triggerStyle.borderColor);
      const borderRatio = contrast(border, bg);
      const caretRatio = caretStyle ? contrast(toRgb(caretStyle.borderRightColor), bg) : 0;
      const caretVisible =
        !!caret &&
        caretStyle &&
        caretStyle.opacity !== "0" &&
        caretStyle.display !== "none";
      return {
        caretVisible,
        borderRatio: Number(borderRatio.toFixed(2)),
        caretRatio: Number(caretRatio.toFixed(2))
      };
    });

  const measureShadowClipping = async (page) => {
    const closeButton = page.locator(".modal .btn").first();
    if (await closeButton.count()) {
      await closeButton.hover();
      await page.waitForTimeout(60);
    }
    return page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll(".modal .btn"));
      for (const btn of buttons) {
        const style = window.getComputedStyle(btn);
        if (!style.boxShadow || style.boxShadow === "none") continue;
        let node = btn.parentElement;
        while (node && !node.classList.contains("modal")) {
          const nodeStyle = window.getComputedStyle(node);
          if (["hidden", "clip", "auto", "scroll"].includes(nodeStyle.overflow)) {
            const btnRect = btn.getBoundingClientRect();
            const nodeRect = node.getBoundingClientRect();
            const nearEdge =
              btnRect.left < nodeRect.left + 2 ||
              btnRect.right > nodeRect.right - 2 ||
              btnRect.top < nodeRect.top + 2 ||
              btnRect.bottom > nodeRect.bottom - 2;
            if (nearEdge) {
              return { pass: false, reason: `ancestor overflow=${nodeStyle.overflow}` };
            }
          }
          node = node.parentElement;
        }
      }
      return { pass: true, reason: "no clipping detected" };
    });
  };

  let browser;
  const artifacts = [];
  try {
    if (shouldStartServer) {
      await run("npm", ["--prefix", "app/webui", "run", "build"], { cwd: repoRoot });
      serverState = await startServerWithRetries(defaultPort, 6);
      baseURL = `http://127.0.0.1:${serverState.port}`;
    }

    browser = await chromium.launch();

    const actionMutex = createMutex();
    const animWorkerLimit =
      parseWorkerLimit(process.env.UI_CHECK_ANIM_WORKERS) ?? Math.min(2, themes.length);
    const animWorkerCount = Math.max(1, Math.min(themes.length, animWorkerLimit));
    const animationLimiter = createLimiter(animWorkerCount);

    const runAnimationCheck = async (themeKey, name, fn) =>
      animationLimiter(() => runCheck(themeKey, name, fn));

  const ensureServerHealthy = async () => {
    if (!shouldStartServer) return;
    const port = serverState?.port ?? getPortFromURL(baseURL);
    if (!port) return;

    const exited =
      serverState?.server?.exitCode !== null && typeof serverState?.server?.exitCode !== "undefined";
    const reachable = await canConnect(port);
    if (!exited && reachable) return;
    if (!exited) {
      await new Promise((r) => setTimeout(r, 160));
      if (await canConnect(port)) return;
    }

    console.warn(`WARN UI preview unreachable on port ${port}; restarting.`);
    await restartServer();
  };

  const runTheme = async (theme) => {
    const colorScheme = theme.mode === "system" ? theme.scheme : theme.mode;
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: videoDir },
      userAgent: "XAUUSDCalendar/1.0",
      bypassCSP: true,
      ...(colorScheme ? { colorScheme } : {})
    });
    await context.addInitScript(() => {
      window.__UI_CHECK_RUNTIME__ = true;
    });
    await context.addInitScript(({ mode, scheme }) => {
      const resolved =
        mode === "system"
          ? scheme ||
            (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
              ? "dark"
              : "light")
          : mode;
      try {
        localStorage.setItem("theme", mode);
        localStorage.setItem("themePreference", mode);
      } catch {
        // ignore
      }
      document.documentElement.dataset.theme = resolved;
      window.__ui_check__ = window.__ui_check__ || {};
      window.__ui_check__.holdInitOverlayMs = 1500;
    }, theme);
    const page = await context.newPage();
    const video = page.video();
    await ensureServerHealthy();
    await gotoWithServerRecovery(page, baseURL, { waitUntil: "domcontentloaded" });
    const initOverlay = page.locator("[data-qa='qa:overlay:init']").first();
    await Promise.all([
      page.waitForSelector("[data-qa='qa:app-shell']", { timeout: 10000 }),
      initOverlay.waitFor({ state: "attached", timeout: 2000 }).catch(() => null)
    ]);
    try {
      const initCard = page.locator("[data-qa='qa:card:init']").first();
      artifacts.push({
        scenario: "init-overlay",
        theme: theme.key,
        state: "loading",
        path: await captureState(page, "init-overlay", theme.key, "loading", { element: initCard })
      });
      await runCheck(theme.key, "Init overlay skeleton contrast", () =>
        assertInitOverlaySkeletonContrast(page, theme.key)
      );
    } catch (err) {
      skipCheck(theme.key, "Init overlay skeleton contrast", "Overlay not visible");
    }
    await page.waitForTimeout(900);
    await injectDesktopBackend(page, theme.mode, false);
    await initOverlay.waitFor({ state: "detached", timeout: 10000 });
    await page.waitForTimeout(500);
    await setTheme(page, theme.mode, theme.scheme);
    await page.waitForTimeout(200);

    artifacts.push({
      scenario: "startup",
      theme: theme.key,
      state: "ready",
      path: await captureState(page, "startup", theme.key, "ready")
    });

    await runCheck(theme.key, "Activity pill label not truncated at idle", async () => {
      const ok = await page.evaluate(() => {
        const label = document.querySelector("[data-qa='qa:action:activity-fab'] .activity-label");
        if (!label) return false;
        const text = (label.textContent || "").trim();
        if (text !== "Activity") return false;
        return label.scrollWidth <= label.clientWidth + 1;
      });
      if (!ok) throw new Error("Activity label appears truncated or unexpected at idle");
    });

    await page.evaluate(() => {
      if (!window.__desktop_snapshot__) return;
      window.__desktop_snapshot__.restartInSeconds = 5;
    });
    await page.evaluate(() => window.__ui_check__?.refresh?.());
    await page.waitForTimeout(120);
    const restartPill = page.locator("[data-qa='qa:restart-countdown']").first();
    if (await restartPill.count()) {
      const frames = await captureFrames(page, "restart-countdown", theme.key, "enter");
      frames.forEach((frame, index) =>
        artifacts.push({
          scenario: "restart-countdown",
          theme: theme.key,
          state: `enter__frame${index}`,
          path: frame
        })
      );
      artifacts.push({
        scenario: "restart-countdown",
        theme: theme.key,
        state: "visible",
        path: await captureState(page, "restart-countdown", theme.key, "visible", {
          element: restartPill
        })
      });
      await runCheck(theme.key, "Restart countdown pill visible", async () => {
        if (!(await restartPill.isVisible())) {
          throw new Error("Restart countdown pill not visible");
        }
      });
      await runCheck(theme.key, "Restart countdown transition presence", async () => {
        const animationName = await restartPill.evaluate((el) => {
          const styles = window.getComputedStyle(el);
          return styles.animationName || "";
        });
        if (!animationName || animationName === "none") {
          throw new Error("Restart countdown pill missing enter animation");
        }
      });
    }

    const historyCard = page.locator("[data-qa='qa:card:history']").first();
    if (await historyCard.count()) {
      await page.evaluate(() => window.__ui_check__?.seedHistoryOverflow?.(2, 7));
      await page.waitForTimeout(180);
      artifacts.push({
        scenario: "history",
        theme: theme.key,
        state: "open",
        path: await captureState(page, "history", theme.key, "open", { element: historyCard })
      });
    }

    await runCheck(theme.key, "Theme icon semantics", () => assertThemeIcons(page, theme.key));
    await runCheck(theme.key, "Desktop crisp mode", () => assertDesktopCrispMode(page));
    await runCheck(theme.key, "Text contrast", () => assertContrast(page));
    await runCheck(theme.key, "Select visibility", () => assertSelectVisibility(page));
    await runCheck(theme.key, "CTA baseline alignment", () =>
      assertBaseline(page, ".appbar-actions .btn, .appbar-actions .pill-link")
    );
    await runCheck(theme.key, "Bottom clock centered 24h", () => assertFooterClock(page));
    await runCheck(theme.key, "Page scrollbars hidden", () => assertNoPageScroll(page));
    await runCheck(theme.key, "Footer stable during viewport resize", async () => {
      const footer = page.locator(".footer-row").first();
      if (!(await footer.count())) {
        throw new Error("Footer row not found");
      }
      const base = page.viewportSize();
      if (!base) {
        throw new Error("Viewport size unavailable");
      }

      const sizes = [
        { width: 1280, height: 720 },
        { width: 1240, height: 718 },
        { width: 1180, height: 712 },
        { width: 1120, height: 706 },
        { width: 1060, height: 698 },
        { width: 1000, height: 690 },
        { width: 960, height: 680 },
        { width: 1020, height: 694 },
        { width: 1280, height: 720 }
      ];

      for (const size of sizes) {
        await page.setViewportSize(size);
        await page.waitForTimeout(80);
        const { ok, reason } = await page.evaluate(() => {
          const footerEl = document.querySelector(".footer-row");
          if (!(footerEl instanceof HTMLElement)) return { ok: false, reason: "footer missing" };
          const rect = footerEl.getBoundingClientRect();
          const viewportH = window.innerHeight;
          // CSS anchors footer to bottom: 10px; allow < 1px tolerance for rounding/compositing.
          const bottomOffset = viewportH - (rect.top + rect.height);
          const delta = Math.abs(bottomOffset - 10);
          if (delta > 0.9) {
            return {
              ok: false,
              reason: `footer bottom offset drifted (offset=${bottomOffset.toFixed(2)}px, delta=${delta.toFixed(2)}px)`
            };
          }
          return { ok: true, reason: "" };
        });
        if (!ok) {
          throw new Error(reason);
        }
      }

      // Restore in case a future refactor changes the loop.
      await page.setViewportSize(base);
    });
    if (theme.key === "light") {
      const splitDivider = page.locator("[data-qa='qa:split:divider']").first();
      if (await splitDivider.count()) {
        artifacts.push({
          scenario: "split-divider",
          theme: theme.key,
          state: "default",
          path: await captureState(page, "split-divider", theme.key, "default", { element: splitDivider })
        });
      }
      await runCheck(theme.key, "Split divider not dark", () => assertSplitDividerNotDark(page));
    }
    await runCheck(theme.key, "Events list completeness", () => assertEventsLoaded(page));
    const eventsCard = page.locator("[data-qa='qa:card:next-events']").first();
    await runCheck(theme.key, "Next Events reorder animation", () =>
      assertNextEventsReorderAnim(page, "evt-2026-01-05-0700-cad-housing-starts")
    );
    if (await eventsCard.count()) {
      artifacts.push({
        scenario: "current-event",
        theme: theme.key,
        state: "active",
        path: await captureState(page, "current-event", theme.key, "active", { element: eventsCard })
      });
    }
    await runCheck(theme.key, "Current event badge", () => assertCurrentEventBadge(page));
    await runCheck(theme.key, "Current event heartbeat", () => assertCurrentEventHeartbeat(page));
    await runCheck(theme.key, "Next Events controls centered", () =>
      assertNextEventsControlsCentered(page)
    );
    await runCheck(theme.key, "Search input visibility", () => assertSearchInputVisibility(page));
    await runCheck(theme.key, "Impact filter not starved", () =>
      assertImpactFilterNotStarved(page)
    );
    await runCheck(theme.key, "Impact tooltips", () => assertImpactTooltips(page));
    await runCheck(theme.key, "History respects impact filter", () =>
      assertHistoryRespectsImpactFilter(page)
    );
    const impactButtons = page.locator("[data-qa='qa:filter:impact'] button.impact-toggle");
    const impactStates = ["low", "mid", "high"];
    if ((await eventsCard.count()) && (await impactButtons.count()) === impactStates.length) {
      for (let index = 0; index < impactStates.length; index += 1) {
        await impactButtons.nth(index).hover();
        await page.waitForTimeout(180);
        artifacts.push({
          scenario: "impact-tooltip",
          theme: theme.key,
          state: impactStates[index],
          path: await captureState(page, "impact-tooltip", theme.key, impactStates[index], {
            element: eventsCard
          })
        });
      }
    }
    await runCheck(theme.key, "History scrolls when overflow", () => assertHistoryScrollable(page));
    await page.evaluate(() => window.__ui_check__?.setSplitRatio?.(0.75));
    await page.waitForTimeout(120);
    await runCheck(theme.key, "History does not overflow when narrow", () => assertHistoryNoOverflow(page));
    const themeBefore = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      mode: document
        .querySelector("[data-qa*='qa:action:theme']")
        ?.getAttribute("data-theme-mode")
    }));
    const themeToggleBtn = page.locator("[data-qa*='qa:action:theme']").first();
    await themeToggleBtn.hover();
    artifacts.push({
      scenario: "theme-toggle",
      theme: theme.key,
      state: "hover",
      path: await captureState(page, "theme-toggle", theme.key, "hover")
    });
    await runCheck(theme.key, "Theme toggle interaction", () => assertThemeToggle(page));
    await setTheme(page, theme.mode, theme.scheme);
    await page.waitForTimeout(120);
    if (theme.key.startsWith("system")) {
      skipCheck(theme.key, "Theme transition synchronized", "System themes skipped");
    } else {
      let transitionFrames = [];
      await runAnimationCheck(theme.key, "Theme transition synchronized", async () => {
        transitionFrames = await assertThemeTransitionSynchronized(page, theme.key);
      });
      transitionFrames.forEach((frame) => {
        artifacts.push({
          scenario: "theme-transition",
          theme: theme.key,
          state: `t${String(frame.ms).padStart(3, "0")}ms`,
          label: `t=${frame.ms}ms (actual ~${frame.actualMs ?? "?"}ms)`,
          path: frame.path
        });
      });
    }
    await page.waitForTimeout(120);
    const themeAfterToggle = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      mode: document
        .querySelector("[data-qa*='qa:action:theme']")
        ?.getAttribute("data-theme-mode")
    }));
    artifacts.push({
      scenario: "theme-toggle",
      theme: theme.key,
      state: "after-toggle",
      label: `after-toggle (${themeBefore.mode ?? themeBefore.theme}->${themeAfterToggle.mode ?? themeAfterToggle.theme})`,
      path: await captureState(page, "theme-toggle", theme.key, "after-toggle")
    });
    await setTheme(page, theme.mode, theme.scheme);
    await page.waitForTimeout(200);
    await runCheck(theme.key, "Theme stability after data refresh", async () => {
      await page.evaluate(() => window.__ui_check__?.refresh?.());
      await page.waitForTimeout(600);
      const after = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        mode: document
          .querySelector("[data-qa*='qa:action:theme']")
          ?.getAttribute("data-theme-mode")
      }));
      if (after.theme !== themeBefore.theme || after.mode !== themeBefore.mode) {
        throw new Error("Theme changed after refresh");
      }
    });

    const layoutWidthBefore = await page.evaluate(() => {
      const appbar = document.querySelector(".appbar");
      const app = document.querySelector(".app");
      const rect = (appbar ?? app)?.getBoundingClientRect();
      return rect ? rect.width : 0;
    });
    const layoutHeightBefore = await page.evaluate(() => {
      const app = document.querySelector(".app");
      const rect = app?.getBoundingClientRect();
      return rect ? rect.height : 0;
    });

    await runCheck(theme.key, "Sync target opens Settings at Paths & Repos (no jump)", async () => {
      const syncTarget = page.locator("[data-qa='qa:action:sync-target']").first();
      if (!(await syncTarget.count())) {
        throw new Error("Sync target pill not found");
      }
      await syncTarget.click();
      await page.waitForSelector("[data-qa*='qa:modal:settings']", { timeout: 1500 });
      const baseline = await page.evaluate(() => {
        const body = document.querySelector("[data-qa='qa:modal-body:settings']");
        const row = document.querySelector("[data-qa='qa:path:main']");
        if (!(body instanceof HTMLElement)) {
          return { ok: false, reason: "Settings modal body not found" };
        }
        if (!(row instanceof HTMLElement)) {
          return { ok: false, reason: "Paths section not found" };
        }
        const bodyRect = body.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        return {
          ok: true,
          scrollTop: body.scrollTop,
          rowTop: rowRect.top - bodyRect.top
        };
      });
      if (!baseline.ok) {
        throw new Error(baseline.reason);
      }
      await page.waitForTimeout(160);
      const after = await page.evaluate(() => {
        const body = document.querySelector("[data-qa='qa:modal-body:settings']");
        if (!(body instanceof HTMLElement)) return { scrollTop: 0 };
        return { scrollTop: body.scrollTop };
      });
      const delta = Math.abs(after.scrollTop - baseline.scrollTop);
      if (delta > 1.5) {
        throw new Error(`Settings scroll jumped after open (delta=${delta.toFixed(2)}px).`);
      }
      if (baseline.scrollTop < 40) {
        throw new Error(`Expected settings to open already scrolled to paths (scrollTop=${baseline.scrollTop.toFixed(1)}).`);
      }
      if (baseline.rowTop < -10 || baseline.rowTop > 240) {
        throw new Error(`Expected paths section near top (rowTop=${baseline.rowTop.toFixed(1)}).`);
      }
      const close = page.locator("[data-qa*='qa:modal-close:settings']").first();
      const waitClosed = async (timeoutMs) =>
        page
          .waitForSelector("[data-qa*='qa:modal-backdrop:settings']", { state: "hidden", timeout: timeoutMs })
          .then(() => true)
          .catch(() => false);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await close.count()) {
          await close.click({ force: true });
        }
        if (await waitClosed(1800)) {
          return true;
        }
        await page.evaluate(() => {
          document
            .querySelector("[data-qa='qa:modal-close:settings']")
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        if (await waitClosed(1800)) {
          return true;
        }
      }

      throw new Error("Settings modal did not close after Sync Target open");
      return true;
    });

    const settingsTrigger = page.locator("[data-qa*='qa:modal-trigger:settings']").first();
    await settingsTrigger.click();
    await page.waitForSelector("[data-qa*='qa:modal:settings']", { timeout: 1000 });
    await runCheck(theme.key, "Modal transition presence", () =>
      assertHasTransition(page, "[data-qa*='qa:modal:settings']", "Settings modal")
    );
    await runCheck(theme.key, "Backdrop transition presence", () =>
      assertHasTransition(page, "[data-qa*='qa:modal-backdrop:settings']", "Modal backdrop")
    );
    if (theme.mode === "system") {
      skipCheck(theme.key, "Modal transition sampling", "System themes skipped");
    } else {
      await runAnimationCheck(theme.key, "Modal transition sampling", () =>
        assertOpacityTransition(page, "[data-qa*='qa:modal:settings']", "Settings modal")
      );
    }
    const enterMetrics = await sampleTransition(page, "[data-qa*='qa:modal:settings']");
    await page.waitForTimeout(160);
    artifacts.push({
      scenario: "settings",
      theme: theme.key,
      state: "open",
      path: await captureState(page, "settings", theme.key, "open")
    });
    await runCheck(theme.key, "Settings open does not snap layout size", async () => {
      // The Settings modal should not cause a 1px app shell resize "snap" after it settles.
      await page.waitForTimeout(260);
      const afterHeight = await page.evaluate(() => {
        const app = document.querySelector(".app");
        const rect = app?.getBoundingClientRect();
        return rect ? rect.height : 0;
      });
      const delta = Math.abs(afterHeight - layoutHeightBefore);
      if (delta > 0.6) {
        throw new Error(`App height changed after opening Settings (delta=${delta.toFixed(2)}px).`);
      }
    });

    const closeBehaviorControl = page.locator("[data-qa='qa:control:close-behavior']").first();
    if (await closeBehaviorControl.count()) {
      await closeBehaviorControl.scrollIntoViewIfNeeded();
      await page.waitForTimeout(140);

      const closeBehaviorTrigger = closeBehaviorControl.locator(".select-trigger").first();
      if (await closeBehaviorTrigger.count()) {
        await closeBehaviorTrigger.click({ force: true });
        await page.waitForTimeout(160);
        artifacts.push({
          scenario: "dropdown-close-behavior",
          theme: theme.key,
          state: "open",
          path: await captureState(page, "dropdown-close-behavior", theme.key, "open")
        });
        await runCheck(theme.key, "Dropdown options do not wrap (close-behavior)", () =>
          assertDropdownNoWrap(page, "close-behavior")
        );
        await closeBehaviorTrigger.click({ force: true });
        await page.waitForTimeout(120);
      }
    }

    const timezoneSection = page.locator("[data-qa='qa:section:calendar-timezone']").first();
    if (await timezoneSection.count()) {
      await timezoneSection.scrollIntoViewIfNeeded();
      await page.waitForTimeout(140);
      artifacts.push({
        scenario: "settings",
        theme: theme.key,
        state: "calendar-timezone",
        path: await captureState(page, "settings", theme.key, "calendar-timezone", {
          element: timezoneSection
        })
      });

      const tzSelectTrigger = timezoneSection
        .locator("[data-qa='qa:select:calendar-utc-offset'] .select-trigger")
        .first();
      if (await tzSelectTrigger.count()) {
        await tzSelectTrigger.click({ force: true });
        await page.waitForTimeout(160);
        artifacts.push({
          scenario: "dropdown-calendar-utc-offset",
          theme: theme.key,
          state: "open",
          path: await captureState(page, "dropdown-calendar-utc-offset", theme.key, "open")
        });
        await runCheck(theme.key, "Dropdown menu layout (calendar-utc-offset)", () =>
          assertDropdownMenu(page, "calendar-utc-offset")
        );
        await tzSelectTrigger.click({ force: true });
        await page.waitForTimeout(120);
      }
    }

    const temporaryPathSection = page.locator("[data-qa='qa:section:temporary-path']").first();
    if (await temporaryPathSection.count()) {
      await temporaryPathSection.scrollIntoViewIfNeeded();
      await page.waitForTimeout(120);
    }

    const temporaryPathToggle = page.locator("[data-qa='qa:control:enable-temporary-path']").first();
    if (await temporaryPathToggle.count()) {
      const input = temporaryPathToggle.locator("input[type='checkbox']").first();
      const checked = await input.isChecked().catch(() => false);
      if (!checked) {
        await temporaryPathToggle.click({ force: true });
        await page.waitForTimeout(180);
      }
    }

    // If the Temporary Path input is empty, the UI should not probe using a hidden backend default
    // (which can surface "overlaps main path" errors for a path the user never chose).
    await page.evaluate(() => {
      window.__ui_check__ = window.__ui_check__ || {};
      window.__ui_check__.mockProbeTemporaryPath = {
        status: "unsafe",
        ready: false,
        needsConfirmation: false,
        canUseAsIs: false,
        canReset: false,
        message: "Temporary Path overlaps Main Path. Choose a separate folder.",
        path: "C:\\\\path\\\\to\\\\main"
      };
    });
    await page.waitForTimeout(220);
    await runCheck(theme.key, "Temporary Path empty path does not show overlaps warning", async () => {
      const errorNote = page.locator("[data-qa='qa:note:temporary-path'][data-tone='error']").first();
      if (await errorNote.count()) {
        throw new Error("Overlaps warning should not appear when Temporary Path is empty");
      }
      const infoNote = page.locator("[data-qa='qa:note:temporary-path'][data-tone='info']").first();
      if (!(await infoNote.count())) {
        throw new Error("Expected info note when Temporary Path is empty");
      }
      const hasReview = await infoNote.locator("[data-qa='qa:action:temporary-path-review']").count();
      if (hasReview) {
        throw new Error("Review button should not appear when Temporary Path is empty");
      }
    });

    const temporaryPathInput = page.locator("[data-qa='qa:section:temporary-path'] input.path-input").first();
    if (await temporaryPathInput.count()) {
      await temporaryPathInput.fill("C:\\\\Users\\\\User\\\\AppData\\\\Roaming\\\\XAUUSDCalendar\\\\repo");
      await page.waitForTimeout(160);
    }

    await page.evaluate(() => {
      window.__ui_check__ = window.__ui_check__ || {};
      window.__ui_check__.mockProbeTemporaryPath = {
        status: "git-not-clean",
        ready: false,
        needsConfirmation: true,
        canUseAsIs: false,
        canReset: true,
        message: "Temporary Path contains extra files",
        path: "C:\\\\Users\\\\User\\\\AppData\\\\Roaming\\\\XAUUSDCalendar\\\\repo"
      };
    });
    await page.waitForTimeout(240);
    const temporaryPathNote = page.locator("[data-qa='qa:note:temporary-path']").first();
    if (await temporaryPathNote.count()) {
      await temporaryPathNote.waitFor({ state: "visible", timeout: 1500 }).catch(() => null);
      artifacts.push({
        scenario: "temporary-path",
        theme: theme.key,
        state: "settings-note",
        path: await captureState(page, "temporary-path", theme.key, "settings-note", {
          element: (await temporaryPathSection.count()) ? temporaryPathSection : temporaryPathNote
        })
      });
    }

    await page.evaluate(() => {
      window.__ui_check__ = window.__ui_check__ || {};
      window.__ui_check__.mockProbeTemporaryPath = {
        status: "empty",
        ready: false,
        needsConfirmation: false,
        canUseAsIs: false,
        canReset: true,
        message: "Folder will be cloned automatically after you close Settings.",
        path: "C:\\\\Users\\\\User\\\\AppData\\\\Roaming\\\\XAUUSDCalendar\\\\repo"
      };
    });
    await page.waitForTimeout(220);
    const temporaryPathNoteAuto = page.locator("[data-qa='qa:note:temporary-path'][data-tone='info']").first();
    if (await temporaryPathNoteAuto.count()) {
      await runCheck(theme.key, "Temporary Path auto-clone note has no Review button", async () => {
        const hasReview = await temporaryPathNoteAuto
          .locator("[data-qa='qa:action:temporary-path-review']")
          .count();
        if (hasReview) {
          throw new Error("Review button should not appear for info notes");
        }
      });
      artifacts.push({
        scenario: "temporary-path",
        theme: theme.key,
        state: "settings-note-auto-clone",
        path: await captureState(page, "temporary-path", theme.key, "settings-note-auto-clone", {
          element: (await temporaryPathSection.count()) ? temporaryPathSection : temporaryPathNoteAuto
        })
      });
    }

    await page.evaluate(() => {
      window.__ui_check__?.setTemporaryPathTask?.({
        active: true,
        phase: "cloning",
        progress: 0.42,
        message: "Cloning...",
        path: "C:\\\\Users\\\\User\\\\AppData\\\\Roaming\\\\XAUUSDCalendar\\\\repo"
      });
    });
    await page.waitForTimeout(220);
    const temporaryPathNoteCloning = page.locator("[data-qa='qa:note:temporary-path'][data-tone='info']").first();
    if (await temporaryPathNoteCloning.count()) {
      await runCheck(theme.key, "Temporary Path cloning note has no Review button", async () => {
        const hasReview = await temporaryPathNoteCloning
          .locator("[data-qa='qa:action:temporary-path-review']")
          .count();
        if (hasReview) {
          throw new Error("Review button should not appear for info notes");
        }
      });
      artifacts.push({
        scenario: "temporary-path",
        theme: theme.key,
        state: "settings-note-cloning",
        path: await captureState(page, "temporary-path", theme.key, "settings-note-cloning", {
          element: (await temporaryPathSection.count()) ? temporaryPathSection : temporaryPathNoteCloning
        })
      });
    }
    await page.evaluate(() => {
      window.__ui_check__?.setTemporaryPathTask?.({
        active: false
      });
    });
    await page.waitForTimeout(120);

    const temporaryPathToggleOff = page.locator("[data-qa='qa:control:enable-temporary-path']").first();
    if (await temporaryPathToggleOff.count()) {
      const input = temporaryPathToggleOff.locator("input[type='checkbox']").first();
      const checked = await input.isChecked().catch(() => false);
      if (checked) {
        await temporaryPathToggleOff.click({ force: true });
        await page.waitForTimeout(180);
      }
    }

    await page.evaluate(() => {
      window.__ui_check__ = window.__ui_check__ || {};
      window.__ui_check__.mockProbeTemporaryPath = null;
    });
    const enterFrames = await captureFrames(page, "settings", theme.key, "enter");
    enterFrames.forEach((frame, index) =>
      artifacts.push({
        scenario: "settings",
        theme: theme.key,
        state: `enter-frame-${index}`,
        path: frame
      })
    );
    await runCheck(theme.key, "Modal header blend", () => assertModalHeaderBlend(page));
    await runCheck(theme.key, "Section rhythm spacing", () => assertSectionRhythm(page));
    await runCheck(theme.key, "Paths button alignment", () => assertPathButtonAlignment(page));
    await runCheck(theme.key, "Shadow clipping", () => assertNoShadowClipping(page));
    await runCheck(theme.key, "Autosave transition presence", () =>
      assertHasTransition(page, ".modal-subtitle", "Autosave status")
    );
    await runCheck(theme.key, "Modal scroll ownership", () => assertModalScroll(page));
    await runCheck(theme.key, "Modal open width stable", async () => {
      const layoutWidthAfter = await page.evaluate(() => {
        const appbar = document.querySelector(".appbar");
        const app = document.querySelector(".app");
        const rect = (appbar ?? app)?.getBoundingClientRect();
        return rect ? rect.width : 0;
      });
      if (!layoutWidthBefore || !layoutWidthAfter) {
        throw new Error("Unable to measure layout width for modal shift check");
      }
      if (Math.abs(layoutWidthAfter - layoutWidthBefore) > 1) {
        throw new Error("Layout width changed when modal opened");
      }
    });
    await runCheck(theme.key, "Page scrollbars hidden (modal open)", () =>
      assertNoPageScroll(page)
    );
    // Autosave shift measured separately for summary.
    const modalBody = page.locator("[data-qa*='qa:modal-body:settings']").first();
    const modalScroll = await measureModalScroll(page);
    const autosaveShiftMax = await measureAutosaveShift(page);
    const selectVisibility = await measureSelectVisibility(page);
    const shadowClip = await measureShadowClipping(page);

    const updateAction = page.locator("[data-qa*='qa:action:update']").first();
    if (await updateAction.count()) {
      const ensureUpdatesVisible = async () => {
        try {
          await updateAction.scrollIntoViewIfNeeded();
        } catch {
          // ignore
        }
        if (await modalBody.count()) {
          await modalBody.evaluate((el) => {
            el.scrollTop = 0;
          });
          await page.waitForTimeout(80);
        }
      };
      const setUpdateState = async (next, expectedPhase) => {
        await page.evaluate((payload) => {
          window.__MOCK_UPDATE_STATE__ = payload;
        }, next);
        await page.evaluate(() => window.__ui_check__?.refreshUpdateState?.());
        if (expectedPhase) {
          try {
            await page.waitForFunction(
              (phase) => {
                const el = document.querySelector("[data-qa*='qa:action:update']");
                const state = el?.getAttribute("data-qa-state") ?? "";
                return state === phase;
              },
              expectedPhase,
              { timeout: 1500 }
            );
          } catch {
            // Ignore if state propagates slowly; snapshot still useful.
          }
        }
      };

      if (await modalBody.count()) {
        await modalBody.evaluate((el) => {
          el.scrollTop = 0;
        });
        await page.waitForTimeout(80);
      }
      await ensureUpdatesVisible();
      await setUpdateState(
        {
          ok: true,
          phase: "idle",
          message: "",
          availableVersion: "",
          progress: 0
        },
        "idle"
      );
      await page.waitForTimeout(120);
      await updateAction.click();
      await page.waitForTimeout(140);
      await setUpdateState(
        {
          ok: true,
          phase: "checking",
          message: "Checking...",
          availableVersion: "",
          progress: 0
        },
        "checking"
      );
      await page.waitForTimeout(260);
      await ensureUpdatesVisible();
      artifacts.push({
        scenario: "updates",
        theme: theme.key,
        state: "checking",
        path: await captureState(page, "updates", theme.key, "checking")
      });
      await setUpdateState(
        {
          ok: true,
          phase: "idle",
          message: "Up to date",
          availableVersion: "",
          progress: 0
        },
        "idle"
      );
      await page.waitForTimeout(180);
      await ensureUpdatesVisible();
      artifacts.push({
        scenario: "updates",
        theme: theme.key,
        state: "up-to-date",
        path: await captureState(page, "updates", theme.key, "up-to-date")
      });
      await setUpdateState(
        {
          ok: true,
          phase: "error",
          message: "Update check failed",
          availableVersion: "",
          progress: 0
        },
        "error"
      );
      await page.waitForTimeout(140);
      artifacts.push({
        scenario: "updates",
        theme: theme.key,
        state: "failure",
        path: await captureState(page, "updates", theme.key, "failure")
      });

      await setUpdateState(
        {
          ok: true,
          phase: "idle",
          message: "",
          availableVersion: "",
          progress: 0
        },
        "idle"
      );
      await page.waitForTimeout(120);

      await updateAction.click();
      await setUpdateState(
        {
          ok: true,
          phase: "available",
          message: "Update available: 9.9.9",
          availableVersion: "9.9.9",
          progress: 0
        },
        "available"
      );
      await page.waitForTimeout(140);
      await ensureUpdatesVisible();
      artifacts.push({
        scenario: "updates",
        theme: theme.key,
        state: "available",
        path: await captureState(page, "updates", theme.key, "available")
      });

      await updateAction.click();
      await page.waitForTimeout(120);
      await setUpdateState(
        {
          ok: true,
          phase: "downloading",
          message: "Downloading...",
          availableVersion: "9.9.9",
          progress: 0.42
        },
        "downloading"
      );
      await page.waitForTimeout(260);
      await ensureUpdatesVisible();
      artifacts.push({
        scenario: "updates",
        theme: theme.key,
        state: "downloading",
        path: await captureState(page, "updates", theme.key, "downloading")
      });

      await setUpdateState(
        {
          ok: true,
          phase: "downloaded",
          message: "Download complete",
          availableVersion: "9.9.9",
          progress: 1
        },
        "downloaded"
      );
      await page.waitForTimeout(180);
      await ensureUpdatesVisible();
      artifacts.push({
        scenario: "updates",
        theme: theme.key,
        state: "downloaded",
        path: await captureState(page, "updates", theme.key, "downloaded")
      });

      await setUpdateState(
        {
          ok: true,
          phase: "idle",
          message: "",
          availableVersion: "",
          progress: 0
        },
        "idle"
      );
      await page.waitForTimeout(80);
    }
    if (await modalBody.count()) {
      await modalBody.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForTimeout(200);
      artifacts.push({
        scenario: "settings",
        theme: theme.key,
        state: "bottom",
        path: await captureState(page, "settings", theme.key, "bottom")
      });
    }
    const uninstallTrigger = page.locator("[data-qa*='qa:modal-trigger:uninstall']").first();
    if (await uninstallTrigger.count()) {
      await uninstallTrigger.click();
      await page.waitForTimeout(160);
      const uninstallFrames = await captureFrames(page, "uninstall", theme.key, "enter");
      uninstallFrames.forEach((frame, index) =>
        artifacts.push({
          scenario: "uninstall",
          theme: theme.key,
          state: `enter-frame-${index}`,
          path: frame
        })
      );
      const uninstallModal = page.locator("[data-qa*='qa:modal:uninstall']").first();
      if (await uninstallModal.count()) {
        artifacts.push({
          scenario: "uninstall",
          theme: theme.key,
          state: "open",
          path: await captureState(page, "uninstall", theme.key, "open", { element: uninstallModal })
        });
      }

      await runCheck(theme.key, "Uninstall confirm enables CTA", async () => {
        const confirmInput = page.locator("[data-qa='qa:uninstall:confirm-input']").first();
        const confirmButton = page.locator("[data-qa='qa:uninstall:confirm-button']").first();
        if (!(await confirmInput.count()) || !(await confirmButton.count())) {
          throw new Error("Uninstall confirm controls not found");
        }
        await confirmInput.fill("");
        await page.waitForTimeout(60);
        if (!(await confirmButton.isDisabled())) {
          throw new Error("Uninstall button should be disabled without confirmation");
        }
        await confirmInput.fill("uninstall");
        await page.waitForTimeout(60);
        if (await confirmButton.isDisabled()) {
          throw new Error("Uninstall button should be enabled for case-insensitive confirmation");
        }
        await confirmInput.fill(" UNINSTALL ");
        await page.waitForTimeout(60);
        if (await confirmButton.isDisabled()) {
          throw new Error("Uninstall button should ignore surrounding whitespace");
        }
        await confirmInput.fill("");
      });

      const uninstallClose = page.locator("[data-qa*='qa:modal-close:uninstall']").first();
      if (await uninstallClose.count()) {
        await uninstallClose.click();
        await page.waitForTimeout(200);
        const uninstallExit = await captureFrames(page, "uninstall", theme.key, "exit");
        uninstallExit.forEach((frame, index) =>
          artifacts.push({
            scenario: "uninstall",
            theme: theme.key,
            state: `exit-frame-${index}`,
            path: frame
          })
        );
      }
    }
    const closeBtn = page.locator("[data-qa*='qa:modal-close:settings']").first();
    if (await closeBtn.count()) {
      await closeBtn.click({ force: true });
    }
    const exitMetrics = await sampleTransition(page, ".modal");
    await page.waitForTimeout(320);
    const exitFrames = await captureFrames(page, "settings", theme.key, "exit");
    exitFrames.forEach((frame, index) =>
      artifacts.push({
        scenario: "settings",
        theme: theme.key,
        state: `exit-frame-${index}`,
        path: frame
      })
    );
    await page
      .waitForSelector("[data-qa*='qa:modal-backdrop:settings']", {
        state: "hidden",
        timeout: 2500
      })
      .catch(() => null);

    await runCheck(theme.key, "Alert modal shows centered + blurred backdrop", async () => {
      await page.evaluate(() =>
        window.__ui_check__?.showAlertModal?.({
          title: "GitHub Token",
          message: "Token verified.\n\nUpdating data...",
          tone: "info"
        })
      );
      await page.waitForSelector("[data-qa='qa:modal:alert']", { timeout: 1200 });
      await page.waitForFunction(
        () => document.querySelector("[data-qa='qa:modal:alert']")?.classList.contains("open"),
        null,
        { timeout: 1500 }
      );
      await page.waitForTimeout(260);
      await assertCenteredInViewport(page, "[data-qa='qa:modal:alert']", "Alert modal");
      await assertBackdropBlurred(page, "[data-qa='qa:modal-backdrop:alert']", "Alert backdrop");
      await assertHasTransition(page, "[data-qa='qa:modal:alert']", "Alert modal");
      await assertHasTransition(page, "[data-qa='qa:modal-backdrop:alert']", "Alert backdrop");
      const enterFrames = await captureFrames(page, "alert", theme.key, "info-enter");
      enterFrames.forEach((frame, index) =>
        artifacts.push({
          scenario: "alert",
          theme: theme.key,
          state: `info-enter-frame-${index}`,
          path: frame
        })
      );
      artifacts.push({
        scenario: "alert",
        theme: theme.key,
        state: "info-open",
        path: await captureState(page, "alert", theme.key, "info-open")
      });
      await page.evaluate(() => window.__ui_check__?.hideAlertModal?.());
      const exitFrames = await captureFrames(page, "alert", theme.key, "info-exit");
      exitFrames.forEach((frame, index) =>
        artifacts.push({
          scenario: "alert",
          theme: theme.key,
          state: `info-exit-frame-${index}`,
          path: frame
        })
      );
      await page.waitForTimeout(240);
      await page
        .waitForSelector("[data-qa='qa:modal-backdrop:alert']", { state: "hidden", timeout: 1500 })
        .catch(() => null);
    });

    await runCheck(theme.key, "Alert modal error tone shows centered", async () => {
      await page.evaluate(() =>
        window.__ui_check__?.showAlertModal?.({
          title: "GitHub Token",
          message: "Token Invalid.\n\nPlease check github_token in config.json",
          tone: "error"
        })
      );
      await page.waitForSelector("[data-qa='qa:modal:alert']", { timeout: 1200 });
      await page.waitForFunction(
        () => document.querySelector("[data-qa='qa:modal:alert']")?.classList.contains("open"),
        null,
        { timeout: 1500 }
      );
      await page.waitForTimeout(260);
      await assertCenteredInViewport(page, "[data-qa='qa:modal:alert']", "Alert modal");
      artifacts.push({
        scenario: "alert",
        theme: theme.key,
        state: "error-open",
        path: await captureState(page, "alert", theme.key, "error-open")
      });
      await page.evaluate(() => window.__ui_check__?.hideAlertModal?.());
      await page.waitForTimeout(240);
      await page
        .waitForSelector("[data-qa='qa:modal-backdrop:alert']", { state: "hidden", timeout: 1500 })
        .catch(() => null);
    });

    const smallContext = await browser.newContext({
      viewport: { width: 960, height: 640 },
      userAgent: "XAUUSDCalendar/1.0",
      bypassCSP: true,
      ...(colorScheme ? { colorScheme } : {})
    });
    await smallContext.addInitScript(() => {
      window.__UI_CHECK_RUNTIME__ = true;
    });
    await smallContext.addInitScript(({ mode, scheme }) => {
      const resolved =
        mode === "system"
          ? scheme ||
            (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
              ? "dark"
              : "light")
          : mode;
      try {
        localStorage.setItem("theme", mode);
        localStorage.setItem("themePreference", mode);
      } catch {
        // ignore
      }
      document.documentElement.dataset.theme = resolved;
      window.__ui_check__ = window.__ui_check__ || {};
      window.__ui_check__.holdInitOverlayMs = 1500;
    }, theme);
    const smallPage = await smallContext.newPage();
    await ensureServerHealthy();
    await gotoWithServerRecovery(smallPage, baseURL, { waitUntil: "domcontentloaded" });
    const smallInitOverlay = smallPage.locator("[data-qa='qa:overlay:init']").first();
    await Promise.all([
      smallPage.waitForSelector("[data-qa='qa:app-shell']", { timeout: 10000 }),
      smallInitOverlay.waitFor({ state: "attached", timeout: 2000 }).catch(() => null)
    ]);
    await injectDesktopBackend(smallPage, theme.mode);
    await smallInitOverlay.waitFor({ state: "detached", timeout: 10000 });
    await smallPage.waitForTimeout(300);
    await setTheme(smallPage, theme.mode, theme.scheme);
    const smallSettingsTrigger = smallPage
      .locator("[data-qa*='qa:modal-trigger:settings']")
      .first();
    await smallSettingsTrigger.click();
    const smallSettingsModal = smallPage.locator("[data-qa*='qa:modal:settings']").first();
    await smallSettingsModal.waitFor({ state: "visible", timeout: 4000 });
    await smallPage.waitForTimeout(160);
    artifacts.push({
      scenario: "settings",
      theme: theme.key,
      state: "open-small",
      path: await captureState(smallPage, "settings", theme.key, "open-small")
    });
    const smallTimezoneSection = smallPage
      .locator("[data-qa='qa:section:calendar-timezone']")
      .first();
    if (await smallTimezoneSection.count()) {
      await smallTimezoneSection.scrollIntoViewIfNeeded();
      await smallPage.waitForTimeout(140);
      artifacts.push({
        scenario: "settings",
        theme: theme.key,
        state: "calendar-timezone-small",
        path: await captureState(smallPage, "settings", theme.key, "calendar-timezone-small", {
          element: smallTimezoneSection
        })
      });
    }
    await runCheck(theme.key, "Modal scroll ownership (small)", () =>
      assertModalScroll(smallPage)
    );
    const smallModalBody = smallPage.locator("[data-qa*='qa:modal-body:settings']").first();
    if (await smallModalBody.count()) {
      await smallModalBody.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await smallPage.waitForTimeout(200);
      artifacts.push({
        scenario: "settings",
        theme: theme.key,
        state: "bottom-small",
        path: await captureState(smallPage, "settings", theme.key, "bottom-small")
      });
    }
    await smallContext.close();

    const selectTriggers = page.locator(".select-trigger");
    const triggerCount = await selectTriggers.count();
    for (let i = 0; i < triggerCount; i += 1) {
      const selectTrigger = selectTriggers.nth(i);
      const name = await selectTrigger.evaluate((el, index) => {
        const root = el.closest(".select");
        const qa = root?.getAttribute("data-qa");
        if (qa && qa.includes("qa:select:")) {
          return qa.replace("qa:select:", "");
        }
        return `select-${index}`;
      }, i);
      await selectTrigger.evaluate((el) => {
        el.scrollIntoView({ block: "start", behavior: "auto" });
      });
      await page.waitForTimeout(120);
      await selectTrigger.hover();
      await selectTrigger.click();
      await page.waitForTimeout(150);
      artifacts.push({
        scenario: `dropdown-${name}`,
        theme: theme.key,
        state: "open",
        path: await captureState(page, `dropdown-${name}`, theme.key, "open")
      });
      const selectMenu = page.locator(".select-menu");
      if (await selectMenu.count()) {
        await selectMenu.first().hover({ force: true });
        await page.waitForTimeout(120);
        artifacts.push({
          scenario: `dropdown-${name}`,
          theme: theme.key,
          state: "hover",
          path: await captureState(page, `dropdown-${name}`, theme.key, "hover")
        });
      }
      await runCheck(theme.key, `Dropdown transition presence (${name})`, () =>
        assertHasTransition(page, ".select-menu", "Dropdown menu")
      );
      await runCheck(theme.key, `Dropdown menu layout (${name})`, () =>
        assertDropdownMenu(page, name)
      );
      await runCheck(theme.key, `Dropdown hover stability (${name})`, () =>
        assertDropdownStableOnHover(page, selectTrigger, name)
      );
      await selectTrigger.click();
    }

    const activityFab = page.locator("[data-qa*='qa:action:activity-fab']").first();
    if (await activityFab.count()) {
      await activityFab.click();
      await page.waitForTimeout(200);
      const drawerSelects = page.locator("[data-qa='qa:drawer:activity'] .select-trigger");
      const drawerCount = await drawerSelects.count();
      for (let i = 0; i < drawerCount; i += 1) {
        const selectTrigger = drawerSelects.nth(i);
        const name = await selectTrigger.evaluate((el, index) => {
          const root = el.closest(".select");
          const qa = root?.getAttribute("data-qa");
          if (qa && qa.includes("qa:select:")) {
            return qa.replace("qa:select:", "");
          }
          return `select-${index}`;
        }, i);
        await selectTrigger.hover();
        await selectTrigger.click();
        await page.waitForTimeout(150);
        artifacts.push({
          scenario: `dropdown-${name}`,
          theme: theme.key,
          state: "open",
          path: await captureState(page, `dropdown-${name}`, theme.key, "open")
        });
        const selectMenu = page.locator(".select-menu");
        if (await selectMenu.count()) {
          await selectMenu.first().hover({ force: true });
          await page.waitForTimeout(120);
          artifacts.push({
            scenario: `dropdown-${name}`,
            theme: theme.key,
            state: "hover",
            path: await captureState(page, `dropdown-${name}`, theme.key, "hover")
          });
        }
        await runCheck(theme.key, `Dropdown transition presence (${name})`, () =>
          assertHasTransition(page, ".select-menu", "Dropdown menu")
        );
        await runCheck(theme.key, `Dropdown menu layout (${name})`, () =>
          assertDropdownMenu(page, name)
        );
        await runCheck(theme.key, `Dropdown hover stability (${name})`, () =>
          assertDropdownStableOnHover(page, selectTrigger, name)
        );
        await selectTrigger.click();
      }
      const activityClose = page.locator("[data-qa='qa:drawer:activity-close']").first();
      if (await activityClose.count()) {
        await activityClose.click();
        await page.waitForTimeout(200);
      }
    }

    await runCheck(theme.key, "History hover shadow settles smoothly", async () => {
      const historyCard = page.locator("[data-qa='qa:card:history']").first();
      const fab = page.locator("[data-qa*='qa:action:activity-fab']").first();
      if (!(await historyCard.count()) || !(await fab.count())) return true;
      const viewport = page.viewportSize();
      const rect = await fab.boundingBox();
      if (!viewport || !rect) return true;

      await historyCard.hover({ force: true });
      await page.waitForTimeout(180);
      await page.mouse.move(24, viewport.height - 24);

      const sampleX = rect.x + Math.min(28, rect.width * 0.25);
      const sampleY = rect.y + rect.height * 0.55;
      const clip = {
        x: Math.max(0, Math.min(viewport.width - 40, Math.round(sampleX - 20))),
        y: Math.max(0, Math.min(viewport.height - 26, Math.round(sampleY - 13))),
        width: 40,
        height: 26
      };

      await page.waitForTimeout(360);
      const earlyBuf = await page.screenshot({ clip });
      await page.waitForTimeout(980);
      const lateBuf = await page.screenshot({ clip });

      const mad = screenshotMad(earlyBuf, lateBuf);
      if (mad > 0.003) {
        const earlyPath = path.join(
          framesDir,
          `${sanitize("history-hover-shadow")}__${sanitize(theme.key)}__t360ms.png`
        );
        const latePath = path.join(
          framesDir,
          `${sanitize("history-hover-shadow")}__${sanitize(theme.key)}__t1340ms.png`
        );
        await fs.writeFile(earlyPath, earlyBuf);
        await fs.writeFile(latePath, lateBuf);
        artifacts.push({
          scenario: "history-hover-shadow",
          theme: theme.key,
          state: "t360ms",
          path: earlyPath
        });
        artifacts.push({
          scenario: "history-hover-shadow",
          theme: theme.key,
          state: "t1340ms",
          path: latePath
        });
        throw new Error(`Late shadow change detected (mad=${mad.toFixed(4)})`);
      }
      return true;
    });

    await actionMutex(async () => {
      const pullButton = page.locator("[data-qa*='qa:action:pull']").first();
      await pullButton.hover();
      artifacts.push({
        scenario: "actions",
        theme: theme.key,
        state: "pull-hover",
        path: await captureState(page, "actions", theme.key, "pull-hover")
      });
      const releasePull = await pressElement(page, pullButton);
      await page.waitForTimeout(80);
      artifacts.push({
        scenario: "actions",
        theme: theme.key,
        state: "pull-press",
        path: await captureState(page, "actions", theme.key, "pull-press")
      });
      await releasePull();
      await pullButton.click();
      await waitForActionLoading(page, "[data-qa*='qa:action:pull']", "[data-qa*='qa:spinner:pull']");
      artifacts.push({
        scenario: "actions",
        theme: theme.key,
        state: "pull-loading",
        path: await captureState(page, "actions", theme.key, "pull-loading")
      });
      await runCheck(theme.key, "Pull spinner animation", () =>
        assertSpinnerAnim(page, "[data-qa*='qa:spinner:pull']", "Pull")
      );
      const toast = page.locator(".toast").first();
      if (await toast.count()) {
        await runCheck(theme.key, "Toast transition presence", () =>
          assertHasTransition(page, ".toast", "Toast")
        );
      } else {
        skipCheck(theme.key, "Toast transition presence", "Toast not present");
      }

      const pullCompletion = await waitForActionCompletion(page, "[data-qa*='qa:action:pull']");
      const pullStateLabel =
        pullCompletion.state === "success"
          ? "pull-success"
          : pullCompletion.state === "error"
            ? "pull-error"
            : pullCompletion.timedOut
              ? "pull-timeout"
              : "pull-final";

      artifacts.push({
        scenario: "actions",
        theme: theme.key,
        state: pullStateLabel,
        path: await captureState(page, "actions", theme.key, pullStateLabel)
      });

      await runCheck(theme.key, "Pull completes with success", async () => {
        if (pullCompletion.state !== "success") {
          const toastSummary = (pullCompletion.toasts || [])
            .map((t) => `${t.type}:${t.text}`)
            .slice(0, 3)
            .join(" | ");
          throw new Error(
            `Pull did not reach success (state=${pullCompletion.state || "?"}, timedOut=${pullCompletion.timedOut}) ` +
              `(label='${pullCompletion.label || ""}', toasts='${toastSummary}')`
          );
        }
        return true;
      });

      // Let the pull button return to idle (it auto-resets after the success flash) so
      // downstream layout-sensitive checks (e.g. sync-target flash) aren't affected by
      // the pull button width transition.
      await page.waitForFunction(
        () => {
          const btn = document.querySelector("[data-qa*='qa:action:pull']");
          return (btn?.getAttribute("data-qa-state") || "") === "idle";
        },
        null,
        { timeout: 6000 }
      );
      await page.waitForTimeout(200);

      const syncButton = page.locator("[data-qa*='qa:action:sync']").first();
      await syncButton.hover();
      artifacts.push({
        scenario: "actions",
        theme: theme.key,
        state: "sync-hover",
        path: await captureState(page, "actions", theme.key, "sync-hover")
      });
      const syncTargetBaseline = await page.evaluate(() => {
        const target = document.querySelector("[data-qa='qa:action:sync-target']");
        const text = (target?.textContent || "").toLowerCase();
        return {
          missing: text.includes("not set"),
          pulse: Number(target?.getAttribute("data-qa-pulse") || "0")
        };
      });

      if (syncTargetBaseline.missing) {
        await runCheck(theme.key, "Sync missing target flashes twice", async () => {
          await syncButton.click();
          const timeline = [];
          for (let i = 0; i < 26; i += 1) {
            timeline.push(
              await page.evaluate(() => {
                const target = document.querySelector("[data-qa='qa:action:sync-target']");
                if (!target) {
                  return {
                    flash: false,
                    borderColor: "",
                    left: 0,
                    top: 0,
                    width: 0,
                    height: 0,
                    afterOpacity: 0
                  };
                }
                const flash = (target.getAttribute("data-qa-flash") || "0") === "1";
                const color = window.getComputedStyle(target).borderColor || "";
                const rect = target.getBoundingClientRect();
                const after = window.getComputedStyle(target, "::after");
                const afterOpacity = Number.parseFloat(after.opacity || "0") || 0;
                return {
                  flash,
                  borderColor: color,
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                  afterOpacity
                };
              })
            );
            await page.waitForTimeout(40);
          }
          let segments = timeline.length && timeline[0].flash ? 1 : 0;
          for (let i = 1; i < timeline.length; i += 1) {
            const prev = timeline[i - 1].flash;
            const cur = timeline[i].flash;
            if (!prev && cur) segments += 1;
          }
          if (segments < 2) {
            throw new Error(`Expected >=2 flash segments, got ${segments}. timeline=${JSON.stringify(timeline)}`);
          }
          const peakOpacity = Math.max(
            ...timeline
              .filter((entry) => entry.flash)
              .map((entry) => entry.afterOpacity || 0)
              .concat([0])
          );
          if (peakOpacity < 0.35) {
            throw new Error(
              `Expected sync-target flash ring to become visible during flash (peakOpacity=${peakOpacity.toFixed(2)}).`
            );
          }
          const widths = timeline.map((entry) => entry.width).filter((value) => value > 0);
          const heights = timeline.map((entry) => entry.height).filter((value) => value > 0);
          const lefts = timeline.map((entry) => entry.left).filter((value) => Number.isFinite(value));
          const tops = timeline.map((entry) => entry.top).filter((value) => Number.isFinite(value));
          const widthDelta = widths.length ? Math.max(...widths) - Math.min(...widths) : 0;
          const heightDelta = heights.length ? Math.max(...heights) - Math.min(...heights) : 0;
          const leftDelta = lefts.length ? Math.max(...lefts) - Math.min(...lefts) : 0;
          const topDelta = tops.length ? Math.max(...tops) - Math.min(...tops) : 0;
          if (widthDelta > 0.75 || heightDelta > 0.75 || leftDelta > 0.75 || topDelta > 0.75) {
            throw new Error(
              `Sync target shifted during flash (widthDelta=${widthDelta.toFixed(2)}px, heightDelta=${heightDelta.toFixed(
                2
              )}px, leftDelta=${leftDelta.toFixed(2)}px, topDelta=${topDelta.toFixed(2)}px).`
            );
          }
          return true;
        });

        await page.waitForTimeout(120);
        artifacts.push({
          scenario: "actions",
          theme: theme.key,
          state: "sync-missing-target",
          path: await captureState(page, "actions", theme.key, "sync-missing-target")
        });
        await runCheck(theme.key, "Sync missing target pulse", async () => {
          const result = await page.evaluate((baselinePulse) => {
            const syncBtn = document.querySelector("[data-qa*='qa:action:sync']");
            const target = document.querySelector("[data-qa='qa:action:sync-target']");
            const spinner = document.querySelector("[data-qa*='qa:spinner:sync']");
            const state = syncBtn?.getAttribute("data-qa-state") || "";
            const label = (syncBtn?.textContent || "").toLowerCase();
            const pulse = Number(target?.getAttribute("data-qa-pulse") || "0");

            if (state !== "idle") {
              return { ok: false, reason: `Sync button entered ${state} while sync target missing` };
            }
            if (label.includes("syncing") || label.includes("failed")) {
              return {
                ok: false,
                reason: `Sync button label unexpected while target missing (label=${label})`
              };
            }
            if (spinner) {
              return { ok: false, reason: "Sync spinner rendered while target missing" };
            }
            if (pulse <= baselinePulse) {
              return { ok: false, reason: `Sync target did not pulse (pulse=${pulse}, baseline=${baselinePulse})` };
            }
            return { ok: true };
          }, syncTargetBaseline.pulse);

          if (!result.ok) {
            throw new Error(result.reason);
          }
          return true;
        });

        await page.evaluate(() => {
          window.__ui_check__?.setOutputDir?.("C:\\\\ui-check\\\\output");
        });
        await page.waitForTimeout(120);
      } else {
        const releaseSync = await pressElement(page, syncButton);
        await page.waitForTimeout(80);
        artifacts.push({
          scenario: "actions",
          theme: theme.key,
          state: "sync-press",
          path: await captureState(page, "actions", theme.key, "sync-press")
        });
        await releaseSync();
        await syncButton.click();
      }

      if (syncTargetBaseline.missing) {
        // Start an actual sync after a target is set.
        await syncButton.click();
      }
      await waitForActionLoading(page, "[data-qa*='qa:action:sync']", "[data-qa*='qa:spinner:sync']");
      artifacts.push({
        scenario: "actions",
        theme: theme.key,
        state: "sync-loading",
        path: await captureState(page, "actions", theme.key, "sync-loading")
      });
      await runCheck(theme.key, "Sync spinner animation", () =>
        assertSpinnerAnim(page, "[data-qa*='qa:spinner:sync']", "Sync")
      );
      if (await toast.count()) {
        await runCheck(theme.key, "Toast transition presence (sync)", () =>
          assertHasTransition(page, ".toast", "Toast")
        );
      } else {
        skipCheck(theme.key, "Toast transition presence (sync)", "Toast not present");
      }

      const syncCompletion = await waitForActionCompletion(page, "[data-qa*='qa:action:sync']");
      const syncStateLabel =
        syncCompletion.state === "success"
          ? "sync-success"
          : syncCompletion.state === "error"
            ? "sync-error"
            : syncCompletion.timedOut
              ? "sync-timeout"
              : "sync-final";
      artifacts.push({
        scenario: "actions",
        theme: theme.key,
        state: syncStateLabel,
        path: await captureState(page, "actions", theme.key, syncStateLabel)
      });
      await runCheck(theme.key, "Sync completes with success", async () => {
        if (syncCompletion.state !== "success") {
          const toastSummary = (syncCompletion.toasts || [])
            .map((t) => `${t.type}:${t.text}`)
            .slice(0, 3)
            .join(" | ");
          throw new Error(
            `Sync did not reach success (state=${syncCompletion.state || "?"}, timedOut=${syncCompletion.timedOut}) ` +
              `(label='${syncCompletion.label || ""}', toasts='${toastSummary}')`
          );
        }
        return true;
      });

      await runCheck(theme.key, "Last sync resets when sync target cleared", async () => {
        await page.evaluate(() => window.__ui_check__?.setOutputDir?.(""));
        await page.waitForTimeout(120);
        const result = await page.evaluate(() => {
          const target = document.querySelector("[data-qa='qa:action:sync-target']");
          const blocks = Array.from(document.querySelectorAll("[data-qa='qa:status:last-sync'] .meta-block"));
          const syncBlock = blocks.find((block) =>
            (block.querySelector(".meta-label")?.textContent || "").toLowerCase().includes("last sync")
          );
          const lastSync = syncBlock?.querySelector(".meta-value") || null;
          return {
            outputMissing: (target?.textContent || "").toLowerCase().includes("not set"),
            lastSyncText: (lastSync?.textContent || "").trim()
          };
        });
        if (!result.outputMissing) {
          throw new Error("Expected sync target to show Not set after clearing output dir");
        }
        if (result.lastSyncText.toLowerCase() !== "not yet") {
          throw new Error(`Expected last sync to be Not yet, got '${result.lastSyncText}'`);
        }
        return true;
      });
    });

    await page.evaluate(() => {});
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.__ui_check__?.appendLog?.("Boot complete", "INFO");
      window.__ui_check__?.appendLog?.("Scheduler started", "INFO");
    });
    await page.waitForTimeout(160);
    const previousMorphOverrides = await page.evaluate(() => {
      const u = window.__ui_check__;
      if (!u) return { motionScale: undefined, morphDelayMs: undefined };
      return { motionScale: u.motionScale, morphDelayMs: u.morphDelayMs };
    });
    await page.evaluate(() => {
      if (!window.__ui_check__) return;
      window.__ui_check__.motionScale = 1.0;
      window.__ui_check__.morphDelayMs = 0;
    });
    const activityFabLate = page.locator("[data-qa*='qa:action:activity-fab']").first();
    if (await activityFabLate.count()) {
      const clip = await computeActivityMorphClip(page);
      if (clip) {
        artifacts.push({
          scenario: "activity-morph",
          theme: theme.key,
          state: "before",
          path: await captureState(page, "activity-morph", theme.key, "before", { clip })
        });
      }
      await page.evaluate(() => {
        document
          .querySelector("[data-qa*='qa:action:activity-fab']")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await page.waitForSelector("[data-qa='qa:drawer:activity']", {
        state: "attached",
        timeout: 2000
      });
      if (clip) {
        const sampleTimes = [
          0, 40, 80, 120, 160, 200, 240, 280, 320, 360, 420, 480, 560, 640, 720, 800, 880, 960
        ];
        const frames = await captureClipFramesAtTimes({
          page,
          scenario: "activity-morph",
          theme: theme.key,
          statePrefix: "open",
          clip,
          sampleTimes,
          probeSelector: "[data-qa='qa:drawer:activity']",
          probes: [
            {
              name: "contentOpacity",
              selector: "[data-qa='qa:drawer:activity'] .activity-drawer-content",
              property: "opacity"
            },
            {
              name: "pillOpacity",
              selector: "[data-qa='qa:drawer:activity'] .activity-drawer-pill-ghost",
              property: "opacity"
            },
            {
              name: "radius",
              selector: "[data-qa='qa:drawer:activity']",
              property: "borderTopLeftRadius"
            }
          ]
        });
        await runAnimationCheck(theme.key, "Activity morph open shows transform change", async () => {
          const transforms = frames
            .map((frame) => frame.transform)
            .filter((value) => typeof value === "string" && value.length);
          if (new Set(transforms).size < 2) {
            throw new Error(`Transform did not change during open (samples=${JSON.stringify(transforms)})`);
          }
        });
        await runAnimationCheck(theme.key, "Activity morph open starts revealing content early", async () => {
          const frame = frames.find((item) => item.ms === 240);
          if (!frame?.probes) throw new Error("Missing probes for t=240ms");
          const opacity = frame.probes.find((p) => p?.name === "contentOpacity")?.value;
          const value = Number.parseFloat(String(opacity ?? ""));
          if (!Number.isFinite(value) || value < 0.05) {
            throw new Error(`Content not visible by t=240ms (opacity=${JSON.stringify(opacity)})`);
          }
        });
        await runAnimationCheck(theme.key, "Activity morph open radius changes mid-flight", async () => {
          const early = frames.find((item) => item.ms === 0)?.probes?.find((p) => p?.name === "radius")?.value;
          const mid = frames.find((item) => item.ms === 120)?.probes?.find((p) => p?.name === "radius")?.value;
          const late = frames.find((item) => item.ms === 880)?.probes?.find((p) => p?.name === "radius")?.value;
          const earlyTransform = frames.find((item) => item.ms === 0)?.transform ?? null;
          const midTransform = frames.find((item) => item.ms === 120)?.transform ?? null;
          const lateTransform = frames.find((item) => item.ms === 880)?.transform ?? null;
          const earlyHeight = frames.find((item) => item.ms === 0)?.rect?.height ?? null;
          const midHeight = frames.find((item) => item.ms === 120)?.rect?.height ?? null;
          const lateHeight = frames.find((item) => item.ms === 880)?.rect?.height ?? null;
          const toPx = (v) => {
            const s = String(v || "").trim();
            const m = s.match(/[\d.]+/);
            return m ? Number(m[0]) : NaN;
          };
          const scaleFromTransform = (value) => {
            const v = String(value || "").trim();
            if (!v || v === "none") return { sx: 1, sy: 1 };
            const matrix2d = v.match(/matrix\(([^)]+)\)/);
            if (!matrix2d) return { sx: 1, sy: 1 };
            const parts = matrix2d[1].split(",").map((p) => Number.parseFloat(p.trim()));
            if (parts.length < 6 || parts.some((n) => !Number.isFinite(n))) return { sx: 1, sy: 1 };
            const [a, b, c, d] = parts;
            const sx = Math.sqrt(a * a + b * b);
            const sy = Math.sqrt(c * c + d * d);
            return { sx: sx || 1, sy: sy || 1 };
          };
          const eScale = scaleFromTransform(earlyTransform);
          const mScale = scaleFromTransform(midTransform);
          const lScale = scaleFromTransform(lateTransform);

          const eRadiusScreen = toPx(early) * eScale.sx;
          const mRadiusScreen = toPx(mid) * mScale.sx;
          const lRadiusScreen = toPx(late) * lScale.sx;
          const eH = Number(earlyHeight);
          const mH = Number(midHeight);
          const lH = Number(lateHeight);

          if (![eRadiusScreen, mRadiusScreen, lRadiusScreen].every((n) => Number.isFinite(n))) {
            throw new Error(`Radius probe parse failed (early=${early}, mid=${mid}, late=${late})`);
          }
          if (![eH, mH, lH].every((n) => Number.isFinite(n) && n > 0)) {
            throw new Error(`Rect height probe failed (early=${earlyHeight}, mid=${midHeight}, late=${lateHeight})`);
          }

          const eRoundness = eRadiusScreen / (eH / 2);
          const mRoundness = mRadiusScreen / (mH / 2);
          const lRoundness = lRadiusScreen / (lH / 2);
          if (![eRoundness, mRoundness, lRoundness].every((n) => Number.isFinite(n) && n > 0)) {
            throw new Error(
              `Roundness calc failed (early=${eRoundness}, mid=${mRoundness}, late=${lRoundness})`
            );
          }
          if (!(mRoundness < eRoundness && mRoundness > lRoundness)) {
            throw new Error(
              `Roundness not transitioning (early=${eRoundness.toFixed(3)}, mid=${mRoundness.toFixed(3)}, late=${lRoundness.toFixed(3)})`
            );
          }
        });
        await runAnimationCheck(theme.key, "Activity morph open starts from pill transform", async () => {
          const first = frames.find((frame) => typeof frame.transform === "string")?.transform ?? null;
          if (!first) throw new Error("Missing transform sample at t=0");
          if (first === "none" || first === "matrix(1, 0, 0, 1, 0, 0)") {
            throw new Error(`Expected non-identity transform at open start, got ${JSON.stringify(first)}`);
          }
        });
        frames.forEach((frame) =>
          artifacts.push({
            scenario: "activity-morph",
            theme: theme.key,
            state: `open__t${String(frame.ms).padStart(3, "0")}ms`,
            label: `t=${frame.ms}ms (actual ~${frame.actualMs ?? "?"}ms)`,
            path: frame.path
          })
        );
      }
      await page.waitForTimeout(40);
    }
    const activityDrawer = page.locator("[data-qa='qa:drawer:activity']").first();
    if (await activityDrawer.count()) {
      await runCheck(theme.key, "Activity drawer does not animate only first log on open", async () => {
        const newCount = await page.locator(".log-new").count();
        if (newCount) {
          throw new Error(`Unexpected log-new rows on open: ${newCount}`);
        }
      });
      artifacts.push({
        scenario: "activity-log",
        theme: theme.key,
        state: "new-entry",
        path: await captureState(page, "activity-log", theme.key, "new-entry", {
          element: activityDrawer
        })
      });
    }

    const activityClose = page.locator("[data-qa='qa:drawer:activity-close']").first();
    if (await activityClose.count()) {
      const clip = await computeActivityMorphClip(page);
      await page.evaluate(() => {
        document
          .querySelector("[data-qa='qa:drawer:activity-close']")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      if (clip) {
        const sampleTimes = [
          0, 40, 80, 120, 160, 200, 240, 280, 320, 360, 420, 480, 560, 640, 720, 820
        ];
        const frames = await captureClipFramesAtTimes({
          page,
          scenario: "activity-morph",
          theme: theme.key,
          statePrefix: "close",
          clip,
          sampleTimes,
          probeSelector: "[data-qa='qa:drawer:activity']",
          probes: [
            {
              name: "contentOpacity",
              selector: "[data-qa='qa:drawer:activity'] .activity-drawer-content",
              property: "opacity"
            },
            {
              name: "pillOpacity",
              selector: "[data-qa='qa:drawer:activity'] .activity-drawer-pill-ghost",
              property: "opacity"
            },
            {
              name: "radius",
              selector: "[data-qa='qa:drawer:activity']",
              property: "borderTopLeftRadius"
            }
          ]
        });
        await runAnimationCheck(theme.key, "Activity morph close shows transform change", async () => {
          const transforms = frames
            .map((frame) => frame.transform)
            .filter((value) => typeof value === "string" && value.length);
          if (new Set(transforms).size < 2) {
            throw new Error(`Transform did not change during close (samples=${JSON.stringify(transforms)})`);
          }
        });
        frames.forEach((frame) =>
          artifacts.push({
            scenario: "activity-morph",
            theme: theme.key,
            state: `close__t${String(frame.ms).padStart(3, "0")}ms`,
            label: `t=${frame.ms}ms (actual ~${frame.actualMs ?? "?"}ms)`,
            path: frame.path
          })
        );
      }
      await page.waitForTimeout(680);
      await runCheck(theme.key, "Activity pill returns after close", async () => {
        const ok = await page.evaluate(() => {
          const pill = document.querySelector("[data-qa*='qa:action:activity-fab']");
          if (!pill) return false;
          const style = window.getComputedStyle(pill);
          if (style.display === "none" || style.visibility === "hidden") return false;
          return Number.parseFloat(style.opacity || "1") > 0.7;
        });
        if (!ok) {
          throw new Error("Activity pill not visible after close");
        }
      });
    }

    await page.evaluate((previous) => {
      if (!window.__ui_check__) return;
      const restore = (key) => {
        if (previous && Object.prototype.hasOwnProperty.call(previous, key)) {
          const value = previous[key];
          if (typeof value === "undefined") {
            delete window.__ui_check__[key];
          } else {
            window.__ui_check__[key] = value;
          }
        } else {
          delete window.__ui_check__[key];
        }
      };
      restore("motionScale");
      restore("morphDelayMs");
    }, previousMorphOverrides);

    await page.evaluate(() => {
      window.__ui_check__?.setTemporaryPathTask?.({
        active: true,
        phase: "cloning",
        progress: 0.42,
        message: "Cloning...",
        path: "C:\\\\Users\\\\User\\\\AppData\\\\Roaming\\\\XAUUSDCalendar\\\\repo"
      });
      window.__ui_check__?.appendLog?.("Temporary Path reset requested", "WARN");
    });
    await page.waitForFunction(() => {
      const ring = document.querySelector(".activity-count-ring");
      if (!ring) return false;
      const style = window.getComputedStyle(ring);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.1;
    });

    const activityFabProgress = page.locator("[data-qa*='qa:action:activity-fab']").first();
    if (await activityFabProgress.count()) {
      await runCheck(theme.key, "Temporary Path progress ring visible", async () => {
        const ok = await page.evaluate(() => {
          const ring = document.querySelector(".activity-count-ring");
          if (!ring) return false;
          const style = window.getComputedStyle(ring);
          return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.1;
        });
        if (!ok) {
          throw new Error("Progress ring not visible");
        }
      });
      artifacts.push({
        scenario: "temporary-path",
        theme: theme.key,
        state: "progress-pill",
        path: await captureState(page, "temporary-path", theme.key, "progress-pill", {
          element: activityFabProgress
        })
      });

      await activityFabProgress.click();
      const activityDrawerProgress = page.locator("[data-qa='qa:drawer:activity']").first();
      if (await activityDrawerProgress.count()) {
        await page.waitForFunction(() => {
          const drawer = document.querySelector("[data-qa='qa:drawer:activity']");
          if (!drawer) return false;
          const style = window.getComputedStyle(drawer);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const transform = style.transform || "none";
          const content = drawer.querySelector(".activity-drawer-content");
          const opacity = content ? Number.parseFloat(window.getComputedStyle(content).opacity || "1") : 1;
          const settled = transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)";
          return settled && Number.isFinite(opacity) && opacity > 0.9;
        });
        artifacts.push({
          scenario: "temporary-path",
          theme: theme.key,
          state: "activity-progress-logs",
          path: await captureState(page, "temporary-path", theme.key, "activity-progress-logs", {
            element: activityDrawerProgress
          })
        });
        const close = page.locator("[data-qa='qa:drawer:activity-close']").first();
        if (await close.count()) {
          await close.click();
          await page.waitForSelector("[data-qa='qa:drawer:activity']", {
            state: "detached",
            timeout: 4000
          });
        }
      }
    }

    await page.evaluate(() => {
      window.__ui_check__?.showTemporaryPathWarning?.({
        mode: "settings-close",
        status: "git-expected-usable",
        message: "Existing Temporary Path looks usable",
        path: "C:\\\\temp-path\\\\xauusd",
        details: "",
        canUseAsIs: true,
        canReset: true
      });
    });
    await page.waitForTimeout(80);
    await runCheck(theme.key, "Temporary Path warning transition (usable)", () =>
      assertOpacityTransition(page, "[data-qa='qa:modal-backdrop:temporary-path-warning']", "Temporary Path warning")
    );
    await runCheck(theme.key, "Temporary Path warning has transition", () =>
      assertHasTransition(page, "[data-qa='qa:modal:temporary-path-warning']", "Temporary Path warning modal")
    );
    const temporaryPathWarningModal = page.locator("[data-qa='qa:modal:temporary-path-warning']").first();
    if (await temporaryPathWarningModal.count()) {
      artifacts.push({
        scenario: "temporary-path",
        theme: theme.key,
        state: "warning-usable",
        path: await captureState(page, "temporary-path", theme.key, "warning-usable", {
          element: temporaryPathWarningModal
        })
      });
      const cancel = page.locator("[data-qa='qa:temporary-path-warning:cancel']").first();
      if (await cancel.count()) {
        await cancel.click();
        await page.waitForTimeout(260);
      }
    }

    await page.evaluate(() => {
      window.__ui_check__?.showTemporaryPathWarning?.({
        mode: "settings-close",
        status: "git-not-clean",
        message: "Temporary Path folder contains local changes",
        path: "C:\\\\temp-path\\\\xauusd",
        details: "",
        canUseAsIs: false,
        canReset: true
      });
    });
    await page.waitForTimeout(80);
    const temporaryPathWarningModalDirty = page.locator("[data-qa='qa:modal:temporary-path-warning']").first();
    if (await temporaryPathWarningModalDirty.count()) {
      artifacts.push({
        scenario: "temporary-path",
        theme: theme.key,
        state: "warning-not-clean",
        path: await captureState(page, "temporary-path", theme.key, "warning-not-clean", {
          element: temporaryPathWarningModalDirty
        })
      });
      const cancel = page.locator("[data-qa='qa:temporary-path-warning:cancel']").first();
      if (await cancel.count()) {
        await cancel.click();
        await page.waitForTimeout(260);
      }
    }

    await page.evaluate(() => {
      window.__ui_check__?.showTemporaryPathWarning?.({
        mode: "settings-close",
        status: "git-origin-mismatch",
        message: "Git repo detected, but origin does not match the configured Temporary Path repo",
        path: "C:\\\\temp-path\\\\other",
        details: "",
        canUseAsIs: false,
        canReset: true
      });
    });
    await page.waitForTimeout(80);
    await runCheck(theme.key, "Temporary Path warning transition (other)", () =>
      assertOpacityTransition(page, "[data-qa='qa:modal-backdrop:temporary-path-warning']", "Temporary Path warning")
    );
    const temporaryPathWarningModalOther = page.locator("[data-qa='qa:modal:temporary-path-warning']").first();
    if (await temporaryPathWarningModalOther.count()) {
      artifacts.push({
        scenario: "temporary-path",
        theme: theme.key,
        state: "warning-other",
        path: await captureState(page, "temporary-path", theme.key, "warning-other", {
          element: temporaryPathWarningModalOther
        })
      });
      const cancel = page.locator("[data-qa='qa:temporary-path-warning:cancel']").first();
      if (await cancel.count()) {
        await cancel.click();
        await page.waitForTimeout(260);
      }
    }

    await page.evaluate(() => {
      window.__ui_check__?.showTemporaryPathWarning?.({
        mode: "settings-close",
        status: "unsafe",
        message: "Temporary Path overlaps Main Path. Choose a separate folder.",
        path: "C:\\\\path\\\\to\\\\main",
        details: "",
        canUseAsIs: false,
        canReset: false
      });
    });
    await page.waitForTimeout(80);
    const temporaryPathWarningModalUnsafe = page.locator("[data-qa='qa:modal:temporary-path-warning']").first();
    if (await temporaryPathWarningModalUnsafe.count()) {
      artifacts.push({
        scenario: "temporary-path",
        theme: theme.key,
        state: "warning-unsafe",
        path: await captureState(page, "temporary-path", theme.key, "warning-unsafe", {
          element: temporaryPathWarningModalUnsafe
        })
      });
      const cancel = page.locator("[data-qa='qa:temporary-path-warning:cancel-x']").first();
      if (await cancel.count()) {
        await cancel.click();
        await page.waitForTimeout(260);
      }
    }

    await page.evaluate(() => {
      window.__ui_check__?.showTemporaryPathWarning?.({
        mode: "settings-close",
        status: "non-git-nonempty",
        message: "Folder contains files",
        path: "C:\\\\temporary-path\\\\junk",
        details: "",
        canUseAsIs: false,
        canReset: true
      });
    });
    await page.waitForTimeout(80);
    const temporaryPathWarningModalNonGit = page.locator("[data-qa='qa:modal:temporary-path-warning']").first();
    if (await temporaryPathWarningModalNonGit.count()) {
      artifacts.push({
        scenario: "temporary-path",
        theme: theme.key,
        state: "warning-non-git",
        path: await captureState(page, "temporary-path", theme.key, "warning-non-git", {
          element: temporaryPathWarningModalNonGit
        })
      });
      const cancel = page.locator("[data-qa='qa:temporary-path-warning:cancel']").first();
      if (await cancel.count()) {
        await cancel.click();
        await page.waitForTimeout(260);
      }
    }

    await page.evaluate(() => {
      window.__ui_check__?.showTemporaryPathWarning?.({
        mode: "settings-close",
        status: "git-unusable",
        message: "Git metadata detected, but the repo is not usable",
        path: "C:\\\\temporary-path\\\\broken",
        details: "fatal: not a git repository (or any of the parent directories): .git\n\nExpected: yiyousiow000814/XAUUSD-Calendar-Agent",
        canUseAsIs: false,
        canReset: true
      });
    });
    await page.waitForTimeout(80);
    const temporaryPathWarningModalUnusable = page.locator("[data-qa='qa:modal:temporary-path-warning']").first();
    if (await temporaryPathWarningModalUnusable.count()) {
      artifacts.push({
        scenario: "temporary-path",
        theme: theme.key,
        state: "warning-git-unusable",
        path: await captureState(page, "temporary-path", theme.key, "warning-git-unusable", {
          element: temporaryPathWarningModalUnusable
        })
      });
      const cancel = page.locator("[data-qa='qa:temporary-path-warning:cancel']").first();
      if (await cancel.count()) {
        await cancel.click();
        await page.waitForTimeout(260);
      }
    }

    // Activity pill notice preview: queue multiple notices (including long ERROR) and
    // verify notices are suppressed during theme transitions.
    try {
      const demoContext = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: "XAUUSDCalendar/1.0",
        bypassCSP: true,
        ...(colorScheme ? { colorScheme } : {})
      });
      await demoContext.addInitScript(() => {
        window.__UI_CHECK_RUNTIME__ = true;
      });
      await demoContext.addInitScript(({ mode, scheme }) => {
        const resolved =
          mode === "system"
            ? scheme ||
              (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
                ? "dark"
                : "light")
            : mode;
        try {
          localStorage.setItem("theme", mode);
          localStorage.setItem("themePreference", mode);
        } catch {
          // ignore
        }
        document.documentElement.dataset.theme = resolved;
        window.__ui_check__ = window.__ui_check__ || {};
        window.__ui_check__.holdInitOverlayMs = 1500;
      }, theme);

      const demoPage = await demoContext.newPage();
      const demoVideo = demoPage.video();
      await ensureServerHealthy();
      await gotoWithServerRecovery(demoPage, baseURL, { waitUntil: "domcontentloaded" });
      await demoPage.waitForSelector("[data-qa='qa:app-shell']", { timeout: 10000 });
      await injectDesktopBackend(demoPage, theme.mode, false);

      const fab = demoPage.locator("[data-qa='qa:action:activity-fab']").first();
      await fab.waitFor({ state: "visible", timeout: 8000 });
      const box = await fab.boundingBox();
      const viewport = demoPage.viewportSize();
      const clip =
        box && viewport
          ? (() => {
              const pad = 18;
              const x = Math.max(0, Math.floor(box.x - pad));
              const y = Math.max(0, Math.floor(box.y - pad));
              const width = Math.min(viewport.width - x, Math.ceil(box.width + pad * 2));
              const height = Math.min(viewport.height - y, Math.ceil(box.height + pad * 2));
              return { x, y, width: Math.max(1, width), height: Math.max(1, height) };
            })()
          : null;

      // Keep the demo short and make the theme transition easy to see in the webm.
      await demoPage.evaluate(() => {
        document.documentElement.style.setProperty("--theme-duration", "650ms");
      });
      await demoPage.waitForTimeout(120);

      await demoPage.evaluate(() => window.__ui_check__?.toggleTheme?.());
      await demoPage
        .waitForFunction(
          () => {
            const root = document.documentElement;
            return root.classList.contains("theme-transition") || root.classList.contains("theme-vt");
          },
          { timeout: 1600 }
        )
        .catch(() => null);

      await demoPage.evaluate(() => {
        const ui = window.__ui_check__;
        ui?.appendLog?.("Events updated to latest", "INFO");
        ui?.appendLog?.("Events updated to latest", "INFO");
        ui?.appendLog?.("Boot complete", "INFO");
        ui?.appendLog?.("Scheduler started", "INFO");
        ui?.appendLog?.(
          "Pull failed: ECONNRESET while reading https://example.invalid/api/calendar?currency=XAUUSD (retry later)",
          "ERROR"
        );
      });

      if (viewport) {
        const clipRight = {
          x: Math.max(0, viewport.width - 560),
          y: 0,
          width: Math.min(560, viewport.width),
          height: viewport.height
        };
        const frames = await captureFrames(
          demoPage,
          "activity-pill-notice-demo",
          theme.key,
          "theme-then-notices",
          { count: 22, gapMs: 120, clip: clipRight }
        );
        if (frames.length) {
          artifacts.push({
            scenario: "activity-pill-notice-demo",
            theme: theme.key,
            state: "theme-then-notices",
            label: "Theme transition then notice flush",
            path: frames[0],
            frames,
            frameGapMs: 120
          });
        }
      }

      await runCheck(theme.key, "Activity pill notice stays suppressed during theme transition", async () => {
        const state = await demoPage.evaluate(() => {
          const root = document.documentElement;
          const anim = root.classList.contains("theme-transition") || root.classList.contains("theme-vt");
          const label = document.querySelector("[data-qa='qa:action:activity-fab'] .activity-label");
          return { anim, text: (label?.textContent || "").trim() };
        });
        if (state.anim && state.text !== "Activity") {
          throw new Error(`Expected Activity label while theme animating, got ${JSON.stringify(state.text)}`);
        }
      });

      await demoPage
        .waitForFunction(
          () => {
            const root = document.documentElement;
            return !root.classList.contains("theme-transition") && !root.classList.contains("theme-vt");
          },
          { timeout: 4000 }
        )
        .catch(() => null);
      await demoPage
        .waitForFunction(
          () => {
            const label = document.querySelector("[data-qa='qa:action:activity-fab'] .activity-label");
            return (label?.textContent || "").trim() !== "Activity";
          },
          { timeout: 6000 }
        )
        .catch(() => null);

      if (clip) {
        const frames = await captureFrames(demoPage, "activity-pill-notice", theme.key, "carousel", {
          count: 12,
          gapMs: 220,
          clip
        });
        if (frames.length) {
          artifacts.push({
            scenario: "activity-pill-notice",
            theme: theme.key,
            state: "carousel",
            label: "Queued notices (info + short info + long error)",
            path: frames[0],
            frames,
            frameGapMs: 220
          });
        }

        await runCheck(theme.key, "Activity pill short notice not truncated", async () => {
          // Re-append a short message right before asserting so fast carousels (no theme transition)
          // cannot advance past it before the check starts.
          await demoPage.evaluate(() => window.__ui_check__?.appendLog?.("Boot complete", "INFO"));
          const ok = await demoPage
            .waitForFunction(
              () => {
                const label = document.querySelector(
                  "[data-qa='qa:action:activity-fab'] .activity-label:not(.activity-label-measure)"
                );
                if (!label) return false;
                const text = (label.textContent || "").trim();
                if (!text.includes("Boot complete")) return false;
                // If ellipsis is applied, scrollWidth will exceed clientWidth.
                return label.scrollWidth <= label.clientWidth + 1;
              },
              { timeout: 8000 }
            )
            .then(() => true)
            .catch(() => false);
          if (!ok) {
            const text = await demoPage.evaluate(() => {
              const label = document.querySelector(
                "[data-qa='qa:action:activity-fab'] .activity-label:not(.activity-label-measure)"
              );
              return { text: (label?.textContent || "").trim(), sw: label?.scrollWidth, cw: label?.clientWidth };
            });
            throw new Error(`Expected 'Boot complete' notice to fit without truncation. Got ${JSON.stringify(text)}`);
          }
        });

        // Capture a static state for a short message so report.html makes this easy to verify.
        await demoPage.evaluate(() => window.__ui_check__?.appendLog?.("Boot complete", "INFO"));
        const sawBoot = await demoPage
          .waitForFunction(
            () => {
              const label = document.querySelector(
                "[data-qa='qa:action:activity-fab'] .activity-label:not(.activity-label-measure)"
              );
              return (label?.textContent || "").trim().includes("Boot complete");
            },
            { timeout: 2000 }
          )
          .then(() => true)
          .catch(() => false);
        if (sawBoot) {
          artifacts.push({
            scenario: "activity-pill-notice",
            theme: theme.key,
            state: "short-info",
            label: "Short info message fits without truncation",
            path: await captureState(demoPage, "activity-pill-notice", theme.key, "short-info", { clip })
          });
        }

        // Force a dedicated long-error capture after the carousel frames, so the static state is reliable.
        await demoPage.evaluate(() => {
          const ui = window.__ui_check__;
          ui?.appendLog?.(
            "Pull failed: ECONNRESET while reading https://example.invalid/api/calendar?currency=XAUUSD (retry later)",
            "ERROR"
          );
        });
        const sawError = await demoPage
          .waitForFunction(
            () => {
              const label = document.querySelector(
                "[data-qa='qa:action:activity-fab'] .activity-label"
              );
              return (label?.textContent || "").trim().startsWith("ERROR:");
            },
            { timeout: 6000 }
          )
          .then(() => true)
          .catch(() => false);
        if (sawError) {
          artifacts.push({
            scenario: "activity-pill-notice",
            theme: theme.key,
            state: "long-error",
            label: "Long error preview truncation",
            path: await captureState(demoPage, "activity-pill-notice", theme.key, "long-error", { clip })
          });
        }

        await demoPage.evaluate(() => window.__ui_check__?.setActivityHover?.(true));
        const hoverTooltip = demoPage.locator("[data-qa='qa:tooltip:activity-notice']").first();
        await hoverTooltip.waitFor({ state: "visible", timeout: 4000 }).catch(() => null);
        if (await hoverTooltip.count()) {
          artifacts.push({
            scenario: "activity-pill-hover",
            theme: theme.key,
            state: "open",
            label: "Hover preview shows recent notices",
            path: await captureState(demoPage, "activity-pill-hover", theme.key, "open", {
              element: hoverTooltip
            })
          });
        }
      }

      await demoContext.close();
    } catch {
      // ignore activity-pill-notice demo failures (main UI check should still complete)
    }

    // Capture a visible Current lifecycle in the theme webm (reorder + move to history).
    await runCurrentTimelineDemo(page);

    themeResults.push({
      theme: theme.key,
      modalEnter: enterMetrics,
      modalExit: exitMetrics,
      modalScroll,
      autosaveShiftMax,
      selectVisibility,
      shadowClip
    });

    await context.close();
    if (video) {
      try {
        const videoPath = await video.path();
        const target = path.join(videoDir, `${sanitize(theme.key)}.webm`);
        await fs.rm(target, { force: true });
        await fs.rename(videoPath, target);
      } catch {
        // ignore video rename failures
      }
    }

  };

    const themeResults = [];
    const workerLimit = parseWorkerLimit(process.env.UI_CHECK_WORKERS) ?? Math.min(2, themes.length);
    const workerCount = Math.max(1, Math.min(themes.length, workerLimit));
    const themeErrors = await runWithPool(themes, workerCount, async (theme) => {
      await ensureServerHealthy();
      await runTheme(theme);
    });
    if (themeErrors.length) {
      const failedThemes = themeErrors
        .map(({ item }) => item?.key || "unknown")
        .filter(Boolean)
        .join(", ");
      throw new Error(`UI-CHECK THEMES FAILED: ${failedThemes}`);
    }

    await browser.close();
    browser = null;
    await stopServer(serverState?.server);
    serverState = null;

    const videos = (await fs.readdir(videoDir))
      .filter((file) => file.endsWith(".webm"))
      .map((file) => path.join(videoDir, file));

    if (!process.env.UI_CHECK_SKIP_REPORT) {
      await generateReport(artifacts, videos, { artifactsRoot, reportPath });
    }

    const summary = checkResults.reduce(
      (acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      },
      {}
    );
    console.log("UI-CHECK SUMMARY", summary);
    console.log("UI-CHECK METRICS", JSON.stringify(themeResults, null, 2));

    const manifestPath = path.join(artifactsRoot, "manifest.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ artifacts, videos, checkResults, artifactsRoot }, null, 2),
      "utf-8"
    );
  } finally {
    try {
      if (browser) await browser.close();
    } catch {
      // ignore
    }
    try {
      if (serverState?.server) await stopServer(serverState.server);
    } catch {
      // ignore
    }
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


