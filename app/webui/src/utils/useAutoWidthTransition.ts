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
  const animationFrameRef = useRef<number | null>(null);
  const transitionCleanupRef = useRef<(() => void) | null>(null);
  const baseInlineWidthRef = useRef<string>("");
  const wroteInlineWidthRef = useRef<boolean>(false);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    transitionCleanupRef.current?.();
    transitionCleanupRef.current = null;

    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (wroteInlineWidthRef.current) {
      element.style.width = baseInlineWidthRef.current;
      wroteInlineWidthRef.current = false;
    }

    const originalInlineWidth = element.style.width;
    baseInlineWidthRef.current = originalInlineWidth;

    const nextWidth = element.getBoundingClientRect().width;
    const previousWidth = previousWidthRef.current;
    previousWidthRef.current = nextWidth;

    if (
      previousWidth === null ||
      Math.abs(previousWidth - nextWidth) < 0.5
    ) {
      return;
    }

    // Intentionally animate only on shrink to avoid the label-outpacing-width
    // issue during expansion (label becomes longer before the control widens).
    if (nextWidth > previousWidth) {
      return () => {
        element.style.width = originalInlineWidth;
      };
    }

    const easing = "cubic-bezier(0.2, 0.85, 0.2, 1)";
    const originalInlineTransition = element.style.transition;
    const originalInlineWillChange = element.style.willChange;

    element.style.width = `${previousWidth}px`;
    wroteInlineWidthRef.current = true;
    element.getBoundingClientRect();

    let finalized = false;
    function finalize() {
      if (finalized) return;
      finalized = true;

      element.removeEventListener("transitionend", onTransitionEnd);
      element.removeEventListener("transitioncancel", onTransitionEnd);

      element.style.transition = originalInlineTransition;
      element.style.willChange = originalInlineWillChange;
      element.style.width = originalInlineWidth;
      wroteInlineWidthRef.current = false;
      transitionCleanupRef.current = null;

      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    }

    function onTransitionEnd(event: TransitionEvent) {
      if (event.target !== element) return;
      if (event.propertyName !== "width") return;
      finalize();
    }

    element.addEventListener("transitionend", onTransitionEnd);
    element.addEventListener("transitioncancel", onTransitionEnd);

    const widthTransition = `width ${durationMs}ms ${easing}`;
    element.style.transition = originalInlineTransition
      ? `${originalInlineTransition}, ${widthTransition}`
      : widthTransition;
    element.style.willChange = "width";

    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null;
      element.style.width = `${nextWidth}px`;
    });

    transitionCleanupRef.current = finalize;

    return () => {
      finalize();
    };
  }, [...deps, durationMs]);

  return elementRef;
}
