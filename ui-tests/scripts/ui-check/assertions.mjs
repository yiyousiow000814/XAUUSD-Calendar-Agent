export const assertModalScroll = async (page) => {
  const result = await page.evaluate(() => {
    const modal = document.querySelector("[data-qa*='qa:modal:settings']");
    const body = document.querySelector("[data-qa*='qa:modal-body:settings']");
    if (!modal || !body) return { ok: false, reason: "modal missing" };
    const before = document.documentElement.scrollTop || document.body.scrollTop;
    body.scrollTop = body.scrollHeight;
    const after = document.documentElement.scrollTop || document.body.scrollTop;
    return { ok: before === after, reason: before === after ? "" : "page scrolled" };
  });
  if (!result.ok) {
    throw new Error(`Modal scroll assertion failed: ${result.reason}`);
  }
};

export const assertBaseline = async (page, selector) => {
  const positions = await page.evaluate((sel) => {
    const nodes = Array.from(document.querySelectorAll(sel));
    return nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, bottom: rect.bottom };
    });
  }, selector);
  if (positions.length < 2) return;
  const bottoms = positions.map((pos) => pos.bottom);
  const min = Math.min(...bottoms);
  const max = Math.max(...bottoms);
  if (max - min > 2) {
    throw new Error("CTA baseline alignment failed");
  }
  const sorted = positions.sort((a, b) => a.x - b.x);
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i].x - sorted[i - 1].x;
    if (gap < 8) {
      throw new Error("CTA spacing below minimum");
    }
  }
};

export const assertAutosaveShift = async (page) => {
  const result = await page.evaluate(() => {
    const status = document.querySelector("[data-qa*='qa:status:autosave']");
    const section = status?.closest(".section");
    if (!section || !status) return { ok: false, reason: "autosave missing" };
    const before = section.getBoundingClientRect().height;
    return { ok: true, before };
  });
  if (!result.ok) {
    throw new Error(`Autosave check failed: ${result.reason}`);
  }
  const input = page.locator('input[type="number"]').first();
  const current = await input.inputValue();
  await input.fill(String(Number(current || "0") + 1));
  await input.blur();
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => {
    const status = document.querySelector("[data-qa*='qa:status:autosave']");
    const section = status?.closest(".section");
    return section ? section.getBoundingClientRect().height : 0;
  });
  if (Math.abs(after - result.before) > 2) {
    throw new Error("Autosave layout shift detected");
  }
};

export const assertContrast = async (page) => {
  const failures = await page.evaluate(() => {
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
    const hexToRgb = (value) => {
      const hex = value.trim();
      if (!hex.startsWith("#")) return [0, 0, 0, 0];
      const clean = hex.replace("#", "");
      const full = clean.length === 3
        ? clean.split("").map((c) => c + c).join("")
        : clean;
      const int = Number.parseInt(full, 16);
      if (Number.isNaN(int)) return [0, 0, 0, 0];
      return [(int >> 16) & 255, (int >> 8) & 255, int & 255, 1];
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
    const getBackground = (el) => {
      const theme = document.documentElement.dataset.theme || "dark";
      const bodyBg = toRgb(window.getComputedStyle(document.body).backgroundColor);
      const varBg = hexToRgb(
        window.getComputedStyle(document.documentElement).getPropertyValue("--bg")
      );
      let node = el;
      while (node) {
        const style = window.getComputedStyle(node);
        const bg = toRgb(style.backgroundColor);
        if (bg[3] >= 0.1) return bg;
        if (style.backgroundImage && style.backgroundImage !== "none") {
          return bodyBg[3] >= 0.1
            ? bodyBg
            : varBg[3] >= 0.1
            ? varBg
            : theme === "light"
            ? [245, 243, 238, 1]
            : [11, 13, 16, 1];
        }
        node = node.parentElement;
      }
      return bodyBg[3] >= 0.1
        ? bodyBg
        : varBg[3] >= 0.1
        ? varBg
        : theme === "light"
        ? [245, 243, 238, 1]
        : [11, 13, 16, 1];
    };
    const candidates = Array.from(
      document.querySelectorAll("h1, h2, h3, p, span, button, label, input")
    )
      .filter((el) => el.textContent && el.textContent.trim().length > 0)
      .slice(0, 140);
    const failures = [];
    for (const el of candidates) {
      const style = window.getComputedStyle(el);
      if (!style.color) continue;
      const fg = toRgb(style.color);
      const bg = getBackground(el);
      const ratio = contrast(fg, bg);
      if (ratio < 3) {
        const theme = document.documentElement.dataset.theme || "unset";
        const bodyBg = window.getComputedStyle(document.body).backgroundColor;
        const varBg = window
          .getComputedStyle(document.documentElement)
          .getPropertyValue("--bg")
          .trim();
        const l1 = luminance(fg[0], fg[1], fg[2]);
        const l2 = luminance(bg[0], bg[1], bg[2]);
        failures.push({
          text: el.textContent?.trim(),
          ratio: ratio.toFixed(2),
          theme,
          bodyBg,
          varBg,
          fg: style.color,
          bg: `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`,
          fgArr: fg,
          bgArr: bg,
          l1: Number.isFinite(l1) ? l1.toFixed(4) : String(l1),
          l2: Number.isFinite(l2) ? l2.toFixed(4) : String(l2)
        });
      }
    }
    return failures.slice(0, 10);
  });
  if (failures.length) {
    throw new Error(`Contrast failures: ${JSON.stringify(failures)}`);
  }
};

export const assertSelectVisibility = async (page) => {
  const result = await page.evaluate(() => {
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
    const triggers = Array.from(document.querySelectorAll(".select-trigger"));
    const failures = [];
    triggers.forEach((trigger) => {
      const caret = trigger.querySelector(".select-caret");
      if (!caret) {
        failures.push("Missing select caret");
        return;
      }
      const triggerStyle = window.getComputedStyle(trigger);
      const caretStyle = window.getComputedStyle(caret);
      const bg = toRgb(triggerStyle.backgroundColor);
      const caretColor = toRgb(caretStyle.borderRightColor);
      const ratio = contrast(caretColor, bg);
      if (ratio < 3) {
        failures.push(`Caret contrast too low: ${ratio.toFixed(2)}`);
      }
      const border = toRgb(triggerStyle.borderColor);
      const borderRatio = contrast(border, bg);
      if (borderRatio < 1.6) {
        failures.push(`Select border contrast too low: ${borderRatio.toFixed(2)}`);
      }
    });
    return failures;
  });
  if (result.length) {
    throw new Error(`Select visibility issues: ${result.join(", ")}`);
  }
};

export const assertImpactTooltips = async (page) => {
  const filter = page.locator("[data-qa='qa:filter:impact']").first();
  if ((await filter.count()) === 0) {
    throw new Error("Impact filter missing");
  }

  const buttons = filter.locator("button.impact-toggle");
  const expected = ["Low Impact", "Medium Impact", "High Impact"];
  const count = await buttons.count();
  if (count !== expected.length) {
    throw new Error(`Expected ${expected.length} impact buttons, found ${count}`);
  }

  for (let index = 0; index < expected.length; index += 1) {
    const button = buttons.nth(index);
    const tooltip = button.locator(".impact-tooltip").first();
    const text = (await tooltip.textContent())?.trim() || "";
    if (text !== expected[index]) {
      throw new Error(`Tooltip label mismatch: expected "${expected[index]}", got "${text}"`);
    }
    await button.hover();
    await page.waitForTimeout(140);
    const opacity = await tooltip.evaluate((node) => {
      const value = window.getComputedStyle(node).opacity;
      return Number.parseFloat(value || "0");
    });
    if (opacity < 0.85) {
      throw new Error(`Tooltip did not appear for "${expected[index]}" (opacity=${opacity})`);
    }
  }
};

export const assertNextEventsControlsCentered = async (page) => {
  const card = page.locator("[data-qa='qa:card:next-events']").first();
  if ((await card.count()) === 0) {
    throw new Error("Next Events card missing");
  }

  const search = card.locator(".search-input").first();
  const currencyTrigger = card.locator("[data-qa='qa:select:currency'] .select-trigger").first();
  const impactButton = card.locator("[data-qa='qa:filter:impact'] button.impact-toggle").first();

  const [searchBox, currencyBox, impactBox] = await Promise.all([
    search.boundingBox(),
    currencyTrigger.boundingBox(),
    impactButton.boundingBox()
  ]);

  if (!searchBox || !currencyBox || !impactBox) {
    throw new Error("Missing bounding boxes for Next Events controls");
  }

  const center = (box) => box.y + box.height / 2;
  const centers = [center(searchBox), center(currencyBox), center(impactBox)];
  const min = Math.min(...centers);
  const max = Math.max(...centers);
  if (max - min > 3) {
    throw new Error(
      `Next Events controls not vertically centered (delta=${(max - min).toFixed(2)}px)`
    );
  }
};

export const assertSearchInputVisibility = async (page) => {
  const result = await page.evaluate(() => {
    const card = document.querySelector("[data-qa='qa:card:next-events']");
    const input = card?.querySelector(".search-input");
    const theme = document.documentElement.dataset.theme || "unset";
    if (!card || !input) return { ok: false, theme, reason: "missing elements" };

    const parse = (value) => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(",").map((part) => part.trim());
      return {
        r: Number(parts[0]),
        g: Number(parts[1]),
        b: Number(parts[2]),
        a: parts[3] === undefined ? 1 : Number(parts[3])
      };
    };
    const luminance = (r, g, b) => {
      const srgb = [r, g, b].map((c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
    };
    const ratio = (fg, bg) => {
      const fgLum = luminance(fg.r, fg.g, fg.b);
      const bgLum = luminance(bg.r, bg.g, bg.b);
      const lighter = Math.max(fgLum, bgLum);
      const darker = Math.min(fgLum, bgLum);
      return (lighter + 0.05) / (darker + 0.05);
    };

    const cardBg = parse(getComputedStyle(card).backgroundColor);
    const inputBg = parse(getComputedStyle(input).backgroundColor);
    const inputBorder = parse(getComputedStyle(input).borderTopColor);
    if (!cardBg || !inputBg || !inputBorder) {
      return {
        ok: false,
        theme,
        reason: "parse failed",
        cardBg: getComputedStyle(card).backgroundColor,
        inputBg: getComputedStyle(input).backgroundColor,
        inputBorder: getComputedStyle(input).borderTopColor
      };
    }

    const bgDelta = ratio(cardBg, inputBg);
    const borderDelta = ratio(inputBorder, inputBg);

    if (theme === "dark") {
      const ok = bgDelta >= 1.18 && borderDelta >= 1.7;
      return { ok, theme, bgDelta, borderDelta };
    }
    return { ok: true, theme, bgDelta, borderDelta };
  });

  if (!result.ok) {
    throw new Error(`Search input visibility failed: ${JSON.stringify(result)}`);
  }
};

export const assertThemeIcons = async (page, themeKey) => {
  const result = await page.evaluate(() => {
    const settingsBtn = document.querySelector("[data-qa*='qa:action:settings']");
    const themeBtn = document.querySelector("[data-qa*='qa:action:theme']");
    return {
      settingsIcon: settingsBtn?.getAttribute("data-icon"),
      settingsSvg: settingsBtn?.querySelector("svg")?.getAttribute("viewBox"),
      themeIcon: themeBtn?.getAttribute("data-icon"),
      themeMode: themeBtn?.getAttribute("data-theme-mode"),
      themeResolved: themeBtn?.getAttribute("data-theme-resolved")
    };
  });
  if (result.settingsIcon !== "gear") {
    throw new Error("Settings icon is not gear");
  }
  if (result.settingsSvg !== "0 0 24 24") {
    throw new Error("Settings icon svg viewBox mismatch");
  }
  if (result.themeIcon !== "sun-moon") {
    throw new Error("Theme icon is not sun-moon");
  }
  if (result.themeResolved === "dark" && result.themeMode === "dark") {
    return;
  }
  if (result.themeResolved === "light" && result.themeMode === "light") {
    return;
  }
  if (result.themeMode === "system" && !["light", "dark"].includes(result.themeResolved)) {
    throw new Error("Theme resolved state missing in system mode");
  }
};

export const assertHistoryNoOverflow = async (page) => {
  const result = await page.evaluate(() => {
    const card = document.querySelector("[data-qa='qa:card:history']");
    if (!card) return { ok: false, reason: "history card missing" };
    const rect = card.getBoundingClientRect();
    const controls = card.querySelector(".history-controls");
    const collapse = card.querySelector("[data-qa*='qa:action:history-collapse']");
    const indicator = card.querySelector(".history-trend");
    const nodes = [controls, collapse, indicator].filter(Boolean);
    const offenders = nodes
      .map((node) => {
        const r = node.getBoundingClientRect();
        return { right: r.right, left: r.left, width: r.width };
      })
      .filter((r) => r.right > rect.right + 1 || r.left < rect.left - 1);
    return {
      ok: offenders.length === 0,
      rect: { left: rect.left, right: rect.right, width: rect.width },
      offenders
    };
  });
  if (!result.ok) {
    throw new Error(`History overflow detected: ${JSON.stringify(result)}`);
  }
};

export const assertModalHeaderBlend = async (page) => {
  const result = await page.evaluate(() => {
    const parseRgba = (value) => {
      const match = String(value || "").match(/rgba?\\(([^)]+)\\)/);
      if (!match) return null;
      const parts = match[1].split(",").map((p) => p.trim());
      const r = Number(parts[0]);
      const g = Number(parts[1]);
      const b = Number(parts[2]);
      const a = parts[3] ? Number(parts[3]) : 1;
      if (![r, g, b, a].every((n) => Number.isFinite(n))) return null;
      return { r, g, b, a };
    };

    const header = document.querySelector(".modal-header");
    const body = document.querySelector(".modal-body");
    const modal = header?.closest(".modal") || document.querySelector(".modal");
    if (!header || !body || !modal) return { ok: false, reason: "modal header missing" };

    const headerStyle = window.getComputedStyle(header);
    const bodyStyle = window.getComputedStyle(body);
    const modalStyle = window.getComputedStyle(modal);

    return {
      ok: true,
      theme: document.documentElement?.getAttribute("data-theme") || "",
      headerBg: headerStyle.backgroundColor,
      headerBgImage: headerStyle.backgroundImage,
      modalBg: modalStyle.backgroundColor,
      modalBgImage: modalStyle.backgroundImage,
      bodyBg: bodyStyle.backgroundColor,
      headerBgParsed: parseRgba(headerStyle.backgroundColor),
      modalBgParsed: parseRgba(modalStyle.backgroundColor),
      bodyBgParsed: parseRgba(bodyStyle.backgroundColor),
      headerPad: parseFloat(headerStyle.paddingLeft || "0"),
      bodyPad: parseFloat(bodyStyle.paddingLeft || "0")
    };
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }

  // Dark theme intentionally uses a header gradient. Light theme must be a single,
  // uniform surface (header == body == modal) to avoid a visible two-tone strip.
  if (result.modalBgImage && result.modalBgImage !== "none") {
    throw new Error(`Modal background image must be none (got=${result.modalBgImage})`);
  }

  if (result.theme === "light") {
    if (result.headerBgImage && result.headerBgImage !== "none") {
      throw new Error(`Modal header background image must be none in light theme (got=${result.headerBgImage})`);
    }
    if (result.modalBg !== result.headerBg) {
      throw new Error(`Modal header background mismatch (header=${result.headerBg}, modal=${result.modalBg})`);
    }
    if (result.bodyBg !== result.headerBg) {
      throw new Error(`Modal body background mismatch (header=${result.headerBg}, body=${result.bodyBg})`);
    }
    if (result.headerBgParsed && result.headerBgParsed.a < 0.999) {
      throw new Error(`Modal header background must be opaque (alpha=${result.headerBgParsed.a})`);
    }
    if (result.modalBgParsed && result.modalBgParsed.a < 0.999) {
      throw new Error(`Modal background must be opaque (alpha=${result.modalBgParsed.a})`);
    }
    if (result.bodyBgParsed && result.bodyBgParsed.a < 0.999) {
      throw new Error(`Modal body background must be opaque (alpha=${result.bodyBgParsed.a})`);
    }
  }

  if (Math.abs(result.headerPad - result.bodyPad) > 1) {
    throw new Error("Modal header padding not aligned with body grid");
  }
};

export const assertSectionRhythm = async (page) => {
  const result = await page.evaluate(() => {
    const sections = Array.from(document.querySelectorAll(".modal-body .section"));
    const issues = [];
    for (let i = 0; i < sections.length; i += 1) {
      const section = sections[i];
      const title = section.querySelector(".section-title");
      const firstControl = title?.nextElementSibling;
      if (title && firstControl) {
        const gap = firstControl.getBoundingClientRect().top - title.getBoundingClientRect().bottom;
        if (gap < 8) {
          issues.push(`Title-to-control gap too small: ${gap.toFixed(1)}px`);
        }
      }
      const next = sections[i + 1];
      if (next) {
        const gap = next.getBoundingClientRect().top - section.getBoundingClientRect().bottom;
        if (gap < 12) {
          issues.push(`Section-to-section gap too small: ${gap.toFixed(1)}px`);
        }
      }
    }
    return issues;
  });
  if (result.length) {
    throw new Error(`Section rhythm issues: ${result.join(", ")}`);
  }
};

export const assertPathButtonAlignment = async (page) => {
  const result = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".path-row .path-actions"));
    if (!rows.length) return { ok: false, reason: "no path buttons" };
    const rights = rows.map((row) => row.getBoundingClientRect().right);
    const widths = rows.map((row) => row.getBoundingClientRect().width);
    const maxRight = Math.max(...rights);
    const minRight = Math.min(...rights);
    const maxWidth = Math.max(...widths);
    const minWidth = Math.min(...widths);
    const buttonWidths = [];
    const buttonHeights = [];
    rows.forEach((row) => {
      const buttons = Array.from(row.querySelectorAll("button"));
      buttons.forEach((btn) => {
        const rect = btn.getBoundingClientRect();
        buttonWidths.push(rect.width);
        buttonHeights.push(rect.height);
      });
    });
    return {
      ok: true,
      rightDelta: maxRight - minRight,
      widthDelta: maxWidth - minWidth,
      btnWidthDelta:
        buttonWidths.length > 0
          ? Math.max(...buttonWidths) - Math.min(...buttonWidths)
          : 0,
      btnHeightDelta:
        buttonHeights.length > 0
          ? Math.max(...buttonHeights) - Math.min(...buttonHeights)
          : 0
    };
  });
  if (!result.ok) {
    throw new Error(`Path button alignment failed: ${result.reason}`);
  }
  if (result.rightDelta > 2 || result.widthDelta > 2) {
    throw new Error("Path button column not aligned");
  }
  if (result.btnWidthDelta > 2 || result.btnHeightDelta > 2) {
    throw new Error("Path buttons are not equal size");
  }
};

export const assertNoShadowClipping = async (page) => {
  const result = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll(".modal .btn"));
    const offenders = [];
    buttons.forEach((btn) => {
      const style = window.getComputedStyle(btn);
      if (!style.boxShadow || style.boxShadow === "none") return;
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
            offenders.push(node.tagName);
            break;
          }
        }
        node = node.parentElement;
      }
    });
    return offenders;
  });
  if (result.length) {
    throw new Error("Button shadow appears clipped by ancestor overflow");
  }
};

export const assertHasTransition = async (page, selector, label) => {
  const result = await page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return { ok: false, reason: "missing" };
    const style = window.getComputedStyle(node);
    return {
      ok: true,
      transition: style.transitionDuration,
      animation: style.animationDuration
    };
  }, selector);
  if (!result.ok) {
    throw new Error(`${label} missing for transition check`);
  }
  const parse = (value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .map((part) => (part.endsWith("ms") ? Number(part.replace("ms", "")) : Number(part.replace("s", "")) * 1000))
      .filter((num) => !Number.isNaN(num));
  const transitions = parse(result.transition);
  const animations = parse(result.animation);
  const max = Math.max(0, ...transitions, ...animations);
  if (max <= 0) {
    throw new Error(`${label} has no transition/animation`);
  }
};

export const assertOpacityTransition = async (page, selector, label) => {
  const sample = async () =>
    page.evaluate((sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      const style = window.getComputedStyle(node);
      return { opacity: Number(style.opacity), transform: style.transform };
    }, selector);
  const samples = [];
  for (let i = 0; i < 7; i += 1) {
    const value = await sample();
    if (value) samples.push(value);
    await page.waitForTimeout(80);
  }
  if (samples.length < 3) {
    throw new Error(`${label} missing for transition sampling`);
  }
  let changed = false;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (!prev || !cur) continue;
    if (prev.opacity !== cur.opacity || prev.transform !== cur.transform) {
      changed = true;
      break;
    }
  }
  if (!changed) {
    throw new Error(`${label} appears to hard-cut without transition`);
  }
};

export const assertTransformTransition = async (page, selector, label) => {
  const sample = async () =>
    page.evaluate((sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      return window.getComputedStyle(node).transform;
    }, selector);

  const samples = [];
  for (let i = 0; i < 5; i += 1) {
    const value = await sample();
    if (value) samples.push(value);
    await page.waitForTimeout(50);
  }

  if (samples.length < 3) {
    throw new Error(`${label} missing for transform sampling`);
  }

  let changed = false;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i - 1] !== samples[i]) {
      changed = true;
      break;
    }
  }

  if (!changed) {
    throw new Error(`${label} transform did not animate (samples=${JSON.stringify(samples)})`);
  }
};

export const assertSpinnerAnim = async (page, selector, label) => {
  const sampleTransform = async () =>
    page.evaluate((sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      const style = window.getComputedStyle(node);
      return style.transform || "";
    }, selector);

  const transforms = [];
  const start = Date.now();
  const timeoutMs = 900;
  while (Date.now() - start < timeoutMs) {
    const value = await sampleTransform();
    if (value) {
      transforms.push(value);
      if (transforms.length >= 6) break;
    }
    await page.waitForTimeout(90);
  }

  if (transforms.length < 2) {
    throw new Error(`${label} spinner missing`);
  }

  const changed = transforms.some((value, index) => index > 0 && value !== transforms[index - 1]);
  if (!changed) {
    throw new Error(`${label} spinner not animating (samples=${JSON.stringify(transforms)})`);
  }
};

export const assertDropdownMenu = async (page, name) => {
  const result = await page.evaluate(() => {
    const select = document.querySelector(".select.open");
    const trigger = select?.querySelector(".select-trigger");
    const menu = document.querySelector(".select-menu.open");
    const footer = document.querySelector(".footer");
    if (!trigger || !menu) {
      return { ok: false, reason: "select menu not open" };
    }
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const footerRect = footer ? footer.getBoundingClientRect() : null;
    const item = menu.querySelector(".select-item");
    const itemRect = item ? item.getBoundingClientRect() : null;
    const menuStyle = window.getComputedStyle(menu);
    const viewportBottom = window.innerHeight;
    const viewportRight = window.innerWidth;
    const visibleItems = itemRect ? Math.floor(menuRect.height / itemRect.height) : 0;
    const scrollable = menu.scrollHeight > menu.clientHeight + 1;
    const scrollState = menu.getAttribute("data-scroll");
    menu.scrollTop = menu.scrollHeight;
    menu.dispatchEvent(new Event("scroll"));
    const scrollStateBottom = menu.getAttribute("data-scroll");
    return {
      ok: true,
      top: menuRect.top,
      bottom: menuRect.bottom,
      right: menuRect.right,
      footerTop: footerRect ? footerRect.top : null,
      triggerBottom: triggerRect.bottom,
      viewportBottom,
      viewportRight,
      scrollWidth: menu.scrollWidth,
      clientWidth: menu.clientWidth,
      visibleItems,
      scrollable,
      scrollState,
      scrollStateBottom,
      overscrollBehavior: menuStyle.overscrollBehaviorY
    };
  });
  if (!result.ok) {
    throw new Error(`Dropdown menu missing for ${name}`);
  }
  if (result.top < result.triggerBottom - 2) {
    throw new Error(`Dropdown opens upward for ${name}`);
  }
  if (result.bottom > result.viewportBottom - 2) {
    throw new Error(`Dropdown overflows viewport for ${name}`);
  }
  if (result.footerTop !== null && result.bottom > result.footerTop - 2) {
    throw new Error(`Dropdown overlaps footer for ${name}`);
  }
  if (result.right > result.viewportRight - 2) {
    throw new Error(`Dropdown overflows viewport width for ${name}`);
  }
  if (result.scrollWidth - result.clientWidth > 2) {
    throw new Error(`Dropdown has horizontal overflow for ${name}`);
  }
  if (result.visibleItems < 3) {
    throw new Error(`Dropdown visible items too few for ${name}`);
  }
  if (result.overscrollBehavior !== "contain" && result.overscrollBehavior !== "none") {
    throw new Error(`Dropdown overscroll not contained for ${name}`);
  }
  if (result.scrollable && result.scrollState === "none") {
    throw new Error(`Dropdown missing scroll indicator for ${name}`);
  }
  if (result.scrollable && result.scrollStateBottom !== "bottom") {
    throw new Error(`Dropdown scroll indicator not updating at bottom for ${name}`);
  }
};

export const assertEventsLoaded = async (page) => {
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll("[data-qa='qa:list:next-events'] [data-qa='qa:row:next-event']")
          .length >= 2,
      null,
      { timeout: 5000 }
    )
    .catch(() => null);
  const result = await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll("[data-qa='qa:list:next-events'] [data-qa='qa:row:next-event']")
    );
    return rows.length;
  });
  if (result < 2) {
    throw new Error("Events list incomplete (less than 2 rows)");
  }
};

export const assertImpactFilterNotStarved = async (page) => {
  await page.evaluate(() => window.__ui_check__?.seedNextEventsImpactOverflow?.(45, 12, 10));
  await page.waitForTimeout(140);

  const lowBtn = page.locator("[data-qa*='qa:filter:impact'] button[aria-label='Low Impact']").first();
  const mediumBtn = page.locator("[data-qa*='qa:filter:impact'] button[aria-label='Medium Impact']").first();
  if (await lowBtn.count()) {
    const active = await lowBtn.evaluate((el) => el.classList.contains("active"));
    if (active) await lowBtn.click();
  }
  if (await mediumBtn.count()) {
    const active = await mediumBtn.evaluate((el) => el.classList.contains("active"));
    if (active) await mediumBtn.click();
  }

  await page.waitForTimeout(160);
  const highCount = await page.evaluate(() => {
    const rows = document.querySelectorAll("[data-qa='qa:card:next-events'] [data-qa='qa:row:next-event']");
    return rows.length;
  });
  if (highCount < 8) {
    throw new Error(`High impact view too sparse after filter (count=${highCount})`);
  }

  if (await lowBtn.count()) {
    const active = await lowBtn.evaluate((el) => el.classList.contains("active"));
    if (!active) await lowBtn.click();
  }
  if (await mediumBtn.count()) {
    const active = await mediumBtn.evaluate((el) => el.classList.contains("active"));
    if (!active) await mediumBtn.click();
  }
  await page.waitForTimeout(120);
};

export const assertHistoryRespectsImpactFilter = async (page) => {
  await page.evaluate(() => window.__ui_check__?.seedHistoryOverflow?.(6, 7));
  await page.waitForTimeout(180);

  const beforeCount = await page.evaluate(() => {
    const history = document.querySelector("[data-qa='qa:card:history']");
    if (!history) return 0;
    return history.querySelectorAll(".history-item.history-event").length;
  });
  if (beforeCount < 6) {
    throw new Error(`History sample too small to validate impact filter (count=${beforeCount})`);
  }

  const lowBtn = page.locator("[data-qa*='qa:filter:impact'] button[aria-label='Low Impact']").first();
  const mediumBtn = page.locator("[data-qa*='qa:filter:impact'] button[aria-label='Medium Impact']").first();
  if (await lowBtn.count()) {
    const active = await lowBtn.evaluate((el) => el.classList.contains("active"));
    if (active) await lowBtn.click();
  }
  if (await mediumBtn.count()) {
    const active = await mediumBtn.evaluate((el) => el.classList.contains("active"));
    if (active) await mediumBtn.click();
  }

  await page.waitForTimeout(160);

  const after = await page.evaluate(() => {
    const history = document.querySelector("[data-qa='qa:card:history']");
    if (!history) return { count: 0, ok: false, reason: "history missing" };
    const items = Array.from(history.querySelectorAll(".history-item.history-event"));
    const impacts = items
      .map((item) => item.querySelector(".history-impact")?.getAttribute("aria-label") || "")
      .map((value) => value.toLowerCase());
    const ok = impacts.every((value) => value.includes("high"));
    return { count: items.length, ok, reason: ok ? "" : `non-high impacts: ${impacts.join(", ")}` };
  });

  if (!after.ok) {
    throw new Error(`History impact filter mismatch: ${after.reason}`);
  }
  if (after.count <= 0 || after.count >= beforeCount) {
    throw new Error(`History impact filter did not reduce results (${beforeCount} -> ${after.count})`);
  }

  if (await lowBtn.count()) {
    const active = await lowBtn.evaluate((el) => el.classList.contains("active"));
    if (!active) await lowBtn.click();
  }
  if (await mediumBtn.count()) {
    const active = await mediumBtn.evaluate((el) => el.classList.contains("active"));
    if (!active) await mediumBtn.click();
  }
  await page.waitForTimeout(120);
};

export const assertHistoryScrollable = async (page) => {
  await page.evaluate(() => window.__ui_check__?.seedHistoryOverflow?.(22, 7));
  await page.waitForTimeout(200);
  const result = await page.evaluate(() => {
    const body = document.querySelector("[data-qa='qa:card:history'] .history-body");
    if (!body) return { ok: false, reason: "missing history body" };
    const canOverflow = body.scrollHeight > body.clientHeight + 2;
    const before = body.scrollTop;
    body.scrollTop = 140;
    const after = body.scrollTop;
    body.scrollTop = before;
    const ok = canOverflow && after > before;
    return { ok, canOverflow, before, after };
  });
  if (!result.ok) {
    throw new Error(
      `History not scrollable (canOverflow=${result.canOverflow}, scrollTop ${result.before}->${result.after})`
    );
  }
};

export const assertNoPageScroll = async (page) => {
  const result = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const docStyle = window.getComputedStyle(doc);
    const bodyStyle = window.getComputedStyle(body);
    return {
      scrollBarX: window.innerWidth - doc.clientWidth,
      scrollBarY: window.innerHeight - doc.clientHeight,
      overflow: `${docStyle.overflow}/${bodyStyle.overflow}`
    };
  });
  if (result.scrollBarX > 1 || result.scrollBarY > 1) {
    throw new Error(
      `Page scrollbars detected (overflow=${result.overflow}, x=${result.scrollBarX}, y=${result.scrollBarY})`
    );
  }
};
