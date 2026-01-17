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

    // Create a real "frosted/blurred" edge by blurring the items themselves near the
    // top/bottom scroll edges (instead of relying on backdrop-filter overlays, which
    // can look like a hard-cut band in some environments).
    const applyEdgeBlur = (mode: "none" | "top" | "middle" | "bottom") => {
      const fadePx = 44;
      const maxBlurPx = 3.4;
      const maxFade = 0.55;

      const enableTop = mode === "middle" || mode === "bottom";
      const enableBottom = mode === "middle" || mode === "top";

      const items = Array.from(scroller.querySelectorAll<HTMLButtonElement>(".select-item"));
      if (!items.length) return;

      // Avoid layout work if no edge effect is expected.
      if (!enableTop && !enableBottom) {
        for (const item of items) {
          item.style.filter = "";
          item.style.opacity = "";
        }
        return;
      }

      const scrollerRect = scroller.getBoundingClientRect();
      for (const item of items) {
        const rect = item.getBoundingClientRect();
        const topDist = rect.top - scrollerRect.top;
        const bottomDist = scrollerRect.bottom - rect.bottom;
        const topProgress = enableTop ? clamp01((fadePx - topDist) / fadePx) : 0;
        const bottomProgress = enableBottom ? clamp01((fadePx - bottomDist) / fadePx) : 0;
        const progress = Math.max(topProgress, bottomProgress);

        if (progress <= 0.001) {
          item.style.filter = "";
          item.style.opacity = "";
          continue;
        }

        const blur = (progress * maxBlurPx).toFixed(2);
        const opacity = (1 - progress * maxFade).toFixed(3);
        item.style.filter = `blur(${blur}px)`;
        item.style.opacity = opacity;
      }
    };

    const updateScrollState = () => {
      if (scroller.scrollHeight <= scroller.clientHeight + 1) {
        menu.dataset.scroll = "none";
        setScrollState("none");
        applyEdgeBlur("none");
        return;
      }
      const atTop = scroller.scrollTop <= 1;
      const atBottom =
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      if (atTop) {
        menu.dataset.scroll = "top";
        setScrollState("top");
        applyEdgeBlur("top");
      } else if (atBottom) {
        menu.dataset.scroll = "bottom";
        setScrollState("bottom");
        applyEdgeBlur("bottom");
      } else {
        menu.dataset.scroll = "middle";
        setScrollState("middle");
        applyEdgeBlur("middle");
      }
    };
    updateScrollState();
    scroller.addEventListener("scroll", updateScrollState);
    window.addEventListener("resize", updateScrollState);
    return () => {
      scroller.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
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
