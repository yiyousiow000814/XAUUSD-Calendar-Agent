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
  const [selectWidth, setSelectWidth] = useState<number | null>(null);
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
      // Keep the DOM attribute updated synchronously so tests and other code can
      // read a correct state immediately after a scroll event.
      if (menu.dataset.scroll !== mode) {
        menu.dataset.scroll = mode;
      }
      // Avoid re-rendering on every scroll event; only update React state when
      // the semantic mode actually changes.
      if (mode !== lastMode) {
        lastMode = mode;
        setScrollState(mode);
      }
    };

    const onScrollOrResize = () => {
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
      setScrollState("none");
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
    let raf: number | null = null;
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
      let maxHeight = Math.min(320, Math.max(0, spaceBelow));

      // If the dropdown would scroll, make the menu height show a consistent "half item"
      // at the bottom. This creates a strong scroll affordance without a blur overlay.
      const scroller = scrollRef.current;

      // Keep the select width stable based on the longest option label, so switching to a
      // shorter label doesn't make other options wrap (e.g. "Minimize to tray").
      let width = rect.width;
      if (scroller && options.length > 0) {
        const sampleItem = scroller.querySelector<HTMLElement>(".select-item");
        if (sampleItem) {
          const itemStyle = window.getComputedStyle(sampleItem);
          const itemPadLeft = Number.parseFloat(itemStyle.paddingLeft) || 0;
          const itemPadRight = Number.parseFloat(itemStyle.paddingRight) || 0;
          const font = itemStyle.font;

          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          if (ctx && font) {
            ctx.font = font;
            const maxTextWidth = options.reduce((acc, option) => {
              const text = option.label || option.value;
              return Math.max(acc, ctx.measureText(text).width);
            }, 0);

            const scrollerStyle = window.getComputedStyle(scroller);
            const scrollerPadLeft = Number.parseFloat(scrollerStyle.paddingLeft) || 0;
            const scrollerPadRight = Number.parseFloat(scrollerStyle.paddingRight) || 0;

            const menuNeeded = maxTextWidth + itemPadLeft + itemPadRight + scrollerPadLeft + scrollerPadRight;
            const triggerStyle = window.getComputedStyle(trigger);
            const triggerPadLeft = Number.parseFloat(triggerStyle.paddingLeft) || 0;
            const triggerPadRight = Number.parseFloat(triggerStyle.paddingRight) || 0;
            const triggerNeeded = maxTextWidth + triggerPadLeft + triggerPadRight;

            width = Math.max(width, menuNeeded, triggerNeeded);
          }
        }
      }

      // Clamp to viewport so we don't create horizontal overflow in narrow windows.
      const viewportCap = Math.max(0, window.innerWidth - rect.left - 16);
      if (viewportCap > 0) {
        width = Math.min(width, viewportCap);
      }
      width = Math.max(0, Math.ceil(width));

      if (scroller && maxHeight > 0) {
        const items = scroller.querySelectorAll<HTMLElement>(".select-item");
        if (items.length >= 2) {
          const item0 = items[0];
          const item1 = items[1];
          const itemHeight = item0.offsetHeight;
          const rowStep = Math.max(0, item1.offsetTop - item0.offsetTop); // includes gap
          const style = window.getComputedStyle(scroller);
          const padTop = Number.parseFloat(style.paddingTop) || 0;
          const padBottom = Number.parseFloat(style.paddingBottom) || 0;
          const gap = Math.max(0, rowStep - itemHeight);
          const totalContent =
            padTop +
            padBottom +
            items.length * itemHeight +
            Math.max(0, items.length - 1) * gap;

          if (totalContent > maxHeight + 1 && rowStep > 0 && itemHeight > 0) {
            const k = Math.max(
              2,
              Math.floor((maxHeight - padTop - padBottom - itemHeight / 2) / rowStep)
            );
            if (k < items.length) {
              const peekHeight = padTop + padBottom + k * rowStep + itemHeight / 2;
              if (peekHeight > 0 && peekHeight <= maxHeight) {
                maxHeight = peekHeight;
              }
            }
          }
        }
      }
      setMenuStyle({
        maxHeight: `${maxHeight}px`,
        // Avoid rounding; fractional CSS pixels happen with zoom/DPI and can make the menu look wider.
        width: `${width}px`
      });
      setSelectWidth((prev) => (prev !== null && Math.abs(prev - width) < 1 ? prev : width));
    };
    updateMenu();
    // The first layout pass can run before grid gaps settle in some environments.
    // Re-run once on the next frame to lock in the intended half-item peek height.
    raf = window.requestAnimationFrame(updateMenu);
    window.addEventListener("resize", updateMenu);
    return () => {
      if (raf !== null) window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", updateMenu);
    };
  }, [open, options.length]);

  return (
    <div
      className={`select${open ? " open" : ""}`}
      ref={rootRef}
      data-qa={qa}
      style={selectWidth ? { width: `${selectWidth}px` } : undefined}
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
