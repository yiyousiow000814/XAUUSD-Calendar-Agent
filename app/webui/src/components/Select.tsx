import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import "./Select.css";

export type SelectOption = { value: string; label: string };

type SelectProps = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  qa?: string;
};

export function Select({ value, options, onChange, qa }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [scrollState, setScrollState] = useState<"none" | "top" | "middle" | "bottom">(
    "none"
  );
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((item) => item.value === value);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    const card = rootRef.current?.closest(".card");
    if (!card) return;
    if (open) {
      card.classList.add("card-select-open");
    }
    return () => {
      card.classList.remove("card-select-open");
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const scroller = scrollRef.current;
    if (!menu || !scroller) return;

    const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
    const blurredRef = { current: new Set<HTMLElement>() };
    let rafId: number | null = null;
    let scheduled = false;

    // Create a real "frosted/blurred" edge by blurring the items themselves near the
    // top/bottom scroll edges (instead of relying on backdrop-filter overlays, which
    // can look like a hard-cut band in some environments).
    const applyEdgeBlur = (mode: "none" | "top" | "middle" | "bottom") => {
      // Keep the effect subtle. Large blur radius + wide fade zone looks "muddy",
      // and can smear too much when the user scrolls quickly.
      const fadePx = 30;
      const maxBlurPx = 2.2;
      const maxFade = 0.34;

      const enableTop = mode === "middle" || mode === "bottom";
      const enableBottom = mode === "middle" || mode === "top";

      const items = Array.from(scroller.querySelectorAll<HTMLButtonElement>(".select-item"));
      if (!items.length) return;

      // Avoid layout work if no edge effect is expected.
      if (!enableTop && !enableBottom) {
        for (const item of blurredRef.current) {
          item.style.filter = "";
          item.style.opacity = "";
        }
        blurredRef.current.clear();
        return;
      }

      // Only touch visible items near the edges; this avoids heavy DOM reads/writes,
      // and prevents a "whole block" looking blurred while scrolling fast.
      const nextBlurred = new Set<HTMLElement>();
      const scrollerRect = scroller.getBoundingClientRect();
      const edgeTop = scrollerRect.top + fadePx;
      const edgeBottom = scrollerRect.bottom - fadePx;

      for (const item of items) {
        const rect = item.getBoundingClientRect();
        // Skip items that are far from the viewport of the scroller.
        if (rect.bottom < scrollerRect.top - fadePx || rect.top > scrollerRect.bottom + fadePx) {
          continue;
        }

        const topDist = rect.top - scrollerRect.top;
        const bottomDist = scrollerRect.bottom - rect.bottom;
        const isNearTop = enableTop && rect.top < edgeTop;
        const isNearBottom = enableBottom && rect.bottom > edgeBottom;
        if (!isNearTop && !isNearBottom) {
          continue;
        }

        const topProgress = isNearTop ? clamp01((fadePx - topDist) / fadePx) : 0;
        const bottomProgress = isNearBottom ? clamp01((fadePx - bottomDist) / fadePx) : 0;
        const progress = Math.max(topProgress, bottomProgress);
        // Ease-in so most of the list stays crisp; only the last ~10-15px looks blurred.
        const eased = Math.pow(progress, 1.6);

        const blur = (eased * maxBlurPx).toFixed(2);
        const opacity = (1 - eased * maxFade).toFixed(3);
        item.style.filter = `blur(${blur}px)`;
        item.style.opacity = opacity;
        nextBlurred.add(item);
      }

      for (const item of blurredRef.current) {
        if (nextBlurred.has(item)) continue;
        item.style.filter = "";
        item.style.opacity = "";
      }
      blurredRef.current = nextBlurred;
    };

    let lastMode: "none" | "top" | "middle" | "bottom" = "none";

    const computeMode = () => {
      if (scroller.scrollHeight <= scroller.clientHeight + 1) return "none";
      const atTop = scroller.scrollTop <= 1;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      if (atTop) return "top";
      if (atBottom) return "bottom";
      return "middle";
    };

    const syncUpdateMode = () => {
      const mode = computeMode();
      lastMode = mode;
      // Keep the DOM attribute updated synchronously so tests and other code can
      // read a correct state immediately after a scroll event.
      if (menu.dataset.scroll !== mode) {
        menu.dataset.scroll = mode;
      }
      setScrollState(mode);
    };

    const scheduleBlurUpdate = () => {
      if (scheduled) return;
      scheduled = true;
      rafId = window.requestAnimationFrame(() => {
        scheduled = false;
        applyEdgeBlur(lastMode);
      });
    };

    const onScrollOrResize = () => {
      syncUpdateMode();
      scheduleBlurUpdate();
    };

    onScrollOrResize();
    scroller.addEventListener("scroll", onScrollOrResize);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      scroller.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      applyEdgeBlur("none");
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (!scroller.contains(event.target as Node)) return;
      const atTop = scroller.scrollTop <= 0;
      const atBottom =
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
        event.preventDefault();
      }
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const updateMenu = () => {
      if (!rootRef.current) return;
      const trigger = triggerRef.current ?? rootRef.current;
      const rect = trigger.getBoundingClientRect();
      const menuOffset = 6;
      const bottomLimit = window.innerHeight - 16;
      const top = rect.bottom + menuOffset;
      const footer = document.querySelector(".footer");
      const footerTop = footer ? footer.getBoundingClientRect().top - 8 : bottomLimit;
      const spaceBelow = Math.max(0, Math.min(bottomLimit, footerTop) - top);
      const maxHeight = Math.min(320, Math.max(0, spaceBelow));
      setMenuStyle({
        maxHeight: `${maxHeight}px`,
        // Avoid rounding; fractional CSS pixels happen with zoom/DPI and can make the menu look wider.
        width: `${rect.width}px`
      });
    };
    updateMenu();
    window.addEventListener("resize", updateMenu);
    return () => {
      window.removeEventListener("resize", updateMenu);
    };
  }, [open, options.length]);

  return (
    <div
      className={`select${open ? " open" : ""}`}
      ref={rootRef}
      data-qa={qa}
    >
      <button
        className="select-trigger"
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        ref={triggerRef}
      >
        <span>{selected?.label ?? value}</span>
        <span className="select-caret" />
      </button>
      {open ? (
        <div
          className="select-menu open"
          ref={menuRef}
          style={menuStyle}
          data-scroll={scrollState}
        >
          <div className="select-menu-border" aria-hidden="true" />
          <div className="select-menu-scroll" ref={scrollRef}>
            {options.map((option) => (
              <button
                className={`select-item${option.value === value ? " active" : ""}`}
                type="button"
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
