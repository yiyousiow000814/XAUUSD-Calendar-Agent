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

    let lastMode: "none" | "top" | "middle" | "bottom" = "none";

    const computeMode = () => {
      if (scroller.scrollHeight <= scroller.clientHeight + 1) return "none";
      const atTop = scroller.scrollTop <= 1;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      if (atTop) return "top";
      if (atBottom) return "bottom";
      return "middle";
    };

    const updateCloudVars = () => {
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (maxScroll <= 1) {
        menu.style.setProperty("--select-cloud-top-opacity", "0");
        menu.style.setProperty("--select-cloud-bottom-opacity", "0");
        return;
      }

      // Smooth fade near edges; keep it capped so it reads as an affordance, not fog.
      const fadePx = 34;
      const topStrength = clamp01(scroller.scrollTop / fadePx);
      const bottomStrength = clamp01((maxScroll - scroller.scrollTop) / fadePx);
      const cap = 0.92;
      menu.style.setProperty("--select-cloud-top-opacity", (topStrength * cap).toFixed(3));
      menu.style.setProperty("--select-cloud-bottom-opacity", (bottomStrength * cap).toFixed(3));
    };

    const syncUpdateMode = () => {
      const mode = computeMode();
      if (mode !== lastMode) {
        lastMode = mode;
      }
      // Keep the DOM attribute updated synchronously so tests and other code can
      // read a correct state immediately after a scroll event.
      if (menu.dataset.scroll !== mode) {
        menu.dataset.scroll = mode;
      }
      setScrollState(mode);
    };

    const onScrollOrResize = () => {
      updateCloudVars();
      syncUpdateMode();
    };

    onScrollOrResize();
    scroller.addEventListener("scroll", onScrollOrResize);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      scroller.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
      // Ensure no stale state is left behind on unmount.
      if (menu.dataset.scroll !== "none") {
        menu.dataset.scroll = "none";
      }
      menu.style.removeProperty("--select-cloud-top-opacity");
      menu.style.removeProperty("--select-cloud-bottom-opacity");
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
