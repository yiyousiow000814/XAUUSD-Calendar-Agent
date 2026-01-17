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
    if (!menu) return;
    const updateScrollState = () => {
      if (menu.scrollHeight <= menu.clientHeight + 1) {
        menu.dataset.scroll = "none";
        setScrollState("none");
        return;
      }
      const atTop = menu.scrollTop <= 1;
      const atBottom = menu.scrollTop + menu.clientHeight >= menu.scrollHeight - 1;
      if (atTop) {
        menu.dataset.scroll = "top";
        setScrollState("top");
      } else if (atBottom) {
        menu.dataset.scroll = "bottom";
        setScrollState("bottom");
      } else {
        menu.dataset.scroll = "middle";
        setScrollState("middle");
      }
    };
    updateScrollState();
    menu.addEventListener("scroll", updateScrollState);
    return () => menu.removeEventListener("scroll", updateScrollState);
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (!menu) return;
    const onWheel = (event: WheelEvent) => {
      if (!menu.contains(event.target as Node)) return;
      const atTop = menu.scrollTop <= 0;
      const atBottom = menu.scrollTop + menu.clientHeight >= menu.scrollHeight - 1;
      if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
        event.preventDefault();
      }
    };
    menu.addEventListener("wheel", onWheel, { passive: false });
    return () => menu.removeEventListener("wheel", onWheel);
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
        width: `${Math.round(rect.width)}px`
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
          <div className="select-menu-inner">
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
