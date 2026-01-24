import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { Locator, Page, TestInfo } from "@playwright/test";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const artifactsRoot = path.join(rootDir, "artifacts");
export const currentDir = path.join(artifactsRoot, "current");
export const baselineDir = path.join(artifactsRoot, "baseline");
export const diffDir = path.join(artifactsRoot, "diff");

export const ensureDir = async (dir: string) => {
  await fs.mkdir(dir, { recursive: true });
};

export const sanitizeName = (value: string) =>
  value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 140);

const resolvePath = (segments: string[]) => path.join(...segments);

export const captureFullPage = async (
  page: Page,
  viewportLabel: string,
  testInfo: TestInfo
) => {
  const folder = resolvePath([currentDir, viewportLabel]);
  await ensureDir(folder);
  const filePath = resolvePath([folder, "full-page.png"]);
  await page.screenshot({ path: filePath, fullPage: true, omitBackground: true });
  testInfo.attachments.push({ name: `full-${viewportLabel}`, path: filePath });
  await compareWithBaseline(filePath, viewportLabel, "full-page", testInfo);
};

export const captureElement = async (
  locator: Locator,
  viewportLabel: string,
  qaName: string,
  testInfo: TestInfo
) => {
  const folder = resolvePath([currentDir, viewportLabel]);
  await ensureDir(folder);
  const fileName = `${sanitizeName(qaName)}.png`;
  const filePath = resolvePath([folder, fileName]);
  await locator.screenshot({ path: filePath, omitBackground: true });
  testInfo.attachments.push({ name: `${qaName}-${viewportLabel}`, path: filePath });
  await compareWithBaseline(filePath, viewportLabel, qaName, testInfo);
};

export const compareWithBaseline = async (
  currentPath: string,
  viewportLabel: string,
  qaName: string,
  testInfo: TestInfo
) => {
  const baselinePath = resolvePath([baselineDir, viewportLabel, `${sanitizeName(qaName)}.png`]);
  try {
    await fs.access(baselinePath);
  } catch {
    testInfo.annotations.push({
      type: "baseline",
      description: `Missing baseline for ${qaName} (${viewportLabel}).`
    });
    return;
  }
  const [currentBuffer, baselineBuffer] = await Promise.all([
    fs.readFile(currentPath),
    fs.readFile(baselinePath)
  ]);
  const current = PNG.sync.read(currentBuffer);
  const baseline = PNG.sync.read(baselineBuffer);
  if (current.width !== baseline.width || current.height !== baseline.height) {
    throw new Error(
      `Baseline size mismatch for ${qaName} (${viewportLabel}): ` +
        `${baseline.width}x${baseline.height} vs ${current.width}x${current.height}`
    );
  }
  const diff = new PNG({ width: current.width, height: current.height });

  const mismatch = pixelmatch(
    current.data,
    baseline.data,
    diff.data,
    current.width,
    current.height,
    { threshold: 0.1 }
  );

  const ratio = mismatch / (current.width * current.height);
  if (ratio > 0.005) {
    const diffFolder = resolvePath([diffDir, viewportLabel]);
    await ensureDir(diffFolder);
    const diffPath = resolvePath([diffFolder, `${sanitizeName(qaName)}.png`]);
    await fs.writeFile(diffPath, PNG.sync.write(diff));
    testInfo.attachments.push({ name: `diff-${qaName}-${viewportLabel}`, path: diffPath });
    throw new Error(`Visual diff detected for ${qaName} (${viewportLabel}), ratio ${ratio}`);
  }
};
