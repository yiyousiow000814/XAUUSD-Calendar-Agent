import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

type UseAutoWidthTransitionOptions = {
  durationMs?: number;
};

export function useAutoWidthTransition<T extends HTMLElement>(
  deps: readonly unknown[],
  options: UseAutoWidthTransitionOptions = {}
): RefObject<T> {
  const { durationMs = 220 } = options;
  const elementRef = useRef<T>(null);
  const previousWidthRef = useRef<number | null>(null);
  const animationRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    if (animationRef.current) {
      animationRef.current.cancel();
      animationRef.current = null;
    }
    element.style.width = "";

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const isPyWebviewApp =
      typeof navigator !== "undefined" && navigator.userAgent.includes("XAUUSDCalendar/");
    const effectiveReducedMotion = prefersReducedMotion && !isPyWebviewApp;

    const nextWidth = element.getBoundingClientRect().width;
    const previousWidth = previousWidthRef.current;
    previousWidthRef.current = nextWidth;

    if (
      effectiveReducedMotion ||
      previousWidth === null ||
      Math.abs(previousWidth - nextWidth) < 0.5
    ) {
      return;
    }

    const originalInlineWidth = element.style.width;

    if (nextWidth > previousWidth) {
      element.style.width = originalInlineWidth;
      return () => {
        element.style.width = originalInlineWidth;
      };
    }

    const easing = "cubic-bezier(0.2, 0.85, 0.2, 1)";
    if (typeof element.animate !== "function") {
      element.style.width = originalInlineWidth;
      return () => {
        element.style.width = originalInlineWidth;
      };
    }

    element.style.width = `${previousWidth}px`;
    element.getBoundingClientRect();

    const animation = element.animate(
      [{ width: `${previousWidth}px` }, { width: `${nextWidth}px` }],
      { duration: durationMs, easing, fill: "forwards" }
    );
    animationRef.current = animation;

    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      if (animationRef.current === animation) {
        animationRef.current = null;
      }
      animation.onfinish = null;
      animation.oncancel = null;
      try {
        animation.cancel();
      } catch {
        // ignore
      }
      element.style.width = originalInlineWidth;
    };

    animation.onfinish = finalize;
    animation.oncancel = finalize;

    return () => {
      animationRef.current?.cancel();
      animationRef.current = null;
      element.style.width = originalInlineWidth;
    };
  }, [...deps, durationMs]);

  return elementRef;
}
