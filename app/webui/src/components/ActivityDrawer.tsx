import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import "./ActivityDrawer.css";

type ActivityDrawerProps = {
  isOpen: boolean;
  isClosing: boolean;
  isEntering: boolean;
  originRect?: DOMRect | null;
  pillContent?: ReactNode;
  externalPillRef?: RefObject<HTMLElement | null> | null;
  onClose: () => void;
  onClosed?: () => void;
  children: ReactNode;
};

export function ActivityDrawer({
  isOpen,
  isClosing,
  isEntering,
  originRect = null,
  pillContent = null,
  externalPillRef = null,
  onClose,
  onClosed,
  children
}: ActivityDrawerProps) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const cancelTweenRef = useRef<(() => void) | null>(null);
  const closeFallbackTimerRef = useRef<number | null>(null);
  const hasNotifiedClosedRef = useRef(false);
  const onClosedRef = useRef<ActivityDrawerProps["onClosed"]>(onClosed);

  useLayoutEffect(() => {
    onClosedRef.current = onClosed;
  }, [onClosed]);

  useLayoutEffect(() => {
    const drawer = drawerRef.current;
    const body = bodyRef.current;
    const content = contentRef.current;
    const pill = pillRef.current;
    const externalPill = externalPillRef?.current ?? null;
    if (!drawer || !body || !content) return;

    if (!isClosing) {
      hasNotifiedClosedRef.current = false;
    }

    const prefersReducedMotion = (() => {
      try {
        return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      } catch {
        return false;
      }
    })();

    const notifyClosed = () => {
      const callback = onClosedRef.current;
      if (!callback || hasNotifiedClosedRef.current) return;
      hasNotifiedClosedRef.current = true;
      window.setTimeout(() => callback(), 0);
    };

    const uiCheck = (window as any).__ui_check__ as
      | { motionScale?: number; morphDelayMs?: number }
      | undefined;
    const motionScale =
      typeof uiCheck?.motionScale === "number" && Number.isFinite(uiCheck.motionScale)
        ? Math.max(0.2, uiCheck.motionScale)
        : 1;
    const morphDelayMs =
      typeof uiCheck?.morphDelayMs === "number" && Number.isFinite(uiCheck.morphDelayMs)
        ? Math.max(0, uiCheck.morphDelayMs)
        : 0;

    const baseMotion = prefersReducedMotion
      ? { openMs: 220, closeMs: 200, overshoot: 1.02 }
      : { openMs: 440, closeMs: 360, overshoot: 1.14 };

    const motion = {
      openMs: Math.round(baseMotion.openMs * motionScale),
      closeMs: Math.round(baseMotion.closeMs * motionScale),
      overshoot: baseMotion.overshoot
    };

    const stopAnimation = () => {
      cancelTweenRef.current?.();
      cancelTweenRef.current = null;
      if (closeFallbackTimerRef.current) {
        window.clearTimeout(closeFallbackTimerRef.current);
        closeFallbackTimerRef.current = null;
      }
    };

    const clamp = (value: number, min: number, max: number) =>
      Math.min(max, Math.max(min, value));

    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    const easeOutBack = (t: number, overshoot: number) => {
      const c1 = overshoot;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    };

    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
    const easeInCubic = (t: number) => t * t * t;

    const syncGhostPillWithExternal = () => {
      if (!pill || !externalPill) return;
      const style = window.getComputedStyle(externalPill);
      pill.style.padding = style.padding;
      pill.style.gap = style.gap;
      pill.style.borderWidth = style.borderTopWidth;
      pill.style.borderStyle = "solid";
      pill.style.borderColor = "transparent";
      pill.style.fontFamily = style.fontFamily;
      pill.style.fontSize = style.fontSize;
      pill.style.fontWeight = style.fontWeight;
      pill.style.letterSpacing = style.letterSpacing;
      pill.style.textTransform = style.textTransform;
      pill.style.lineHeight = style.lineHeight;
    };

    const syncPillMaterialVars = () => {
      if (!externalPill) return;
      const style = window.getComputedStyle(externalPill);
      drawer.style.setProperty("--activity-morph-pill-bg", style.backgroundColor);
      drawer.style.setProperty("--activity-morph-pill-border", style.borderTopColor);
      drawer.style.setProperty("--activity-morph-pill-shadow", style.boxShadow);
    };

    const runTween = (
      duration: number,
      onUpdate: (t: number) => void,
      onDone: () => void,
      delayMs = 0
    ) => {
      let raf = 0;
      let stopped = false;
      const start = performance.now();
      const tick = (now: number) => {
        if (stopped) return;
        const elapsed = now - start - delayMs;
        const raw = clamp(elapsed / duration, 0, 1);
        onUpdate(raw);
        if (raw < 1) {
          raf = window.requestAnimationFrame(tick);
          return;
        }
        onDone();
      };
      raf = window.requestAnimationFrame(tick);
      return () => {
        stopped = true;
        window.cancelAnimationFrame(raf);
      };
    };

    if (!isEntering && !isClosing) return;

    let raf = 0;
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 10;

    const startAnimation = () => {
      if (cancelled) return;

      const finalRect = drawer.getBoundingClientRect();
      if (!finalRect.width || !finalRect.height) {
        attempts += 1;
        if (attempts < maxAttempts) {
          raf = window.requestAnimationFrame(startAnimation);
        }
        return;
      }

      const computedRadius = (() => {
        const value = Number.parseFloat(window.getComputedStyle(drawer).borderTopLeftRadius);
        return Number.isFinite(value) && value > 0 ? value : 20;
      })();

      const fallbackOrigin = {
        dx: 0,
        dy: 12,
        sx: 0.98,
        sy: 0.98,
        pillRadiusPx: computedRadius
      };
      const origin = originRect
        ? {
            dx: originRect.left - finalRect.left,
            dy: originRect.top - finalRect.top,
            sx: Math.max(0.01, originRect.width / finalRect.width),
            sy: Math.max(0.01, originRect.height / finalRect.height),
            pillRadiusPx: Math.max(12, Math.round(originRect.height / 2))
          }
        : fallbackOrigin;

      const originCapsuleRadiusScreen = clamp(
        originRect?.height ? originRect.height / 2 : (finalRect.height * origin.sy) / 2,
        12,
        999
      );

      const setShellRadius = (radiusScreenPx: number, scaleX: number, scaleY: number) => {
        const safeScaleX = Math.max(0.01, Math.abs(scaleX));
        const safeScaleY = Math.max(0.01, Math.abs(scaleY));
        const rx = clamp(radiusScreenPx / safeScaleX, 0, 999);
        const ry = clamp(radiusScreenPx / safeScaleY, 0, 999);
        drawer.style.borderRadius = `${rx.toFixed(2)}px / ${ry.toFixed(2)}px`;
      };

      const setPillTransform = (scaleX: number, scaleY: number) => {
        if (!pill) return;
        const safeScaleX = Math.max(0.01, Math.abs(scaleX));
        const safeScaleY = Math.max(0.01, Math.abs(scaleY));
        const invScaleX = clamp(1 / safeScaleX, 0.01, 100);
        const invScaleY = clamp(1 / safeScaleY, 0.01, 100);
        pill.style.transformOrigin = "top left";
        pill.style.transform = `scale(${invScaleX.toFixed(6)}, ${invScaleY.toFixed(6)})`;
      };

      if (isEntering) {
        stopAnimation();

        syncGhostPillWithExternal();
        syncPillMaterialVars();

        drawer.style.willChange = "transform, border-radius, opacity";
        drawer.style.transformOrigin = "top left";
        drawer.style.transform = `translate3d(${origin.dx}px, ${origin.dy}px, 0) scale(${origin.sx}, ${origin.sy})`;
        setShellRadius(originCapsuleRadiusScreen, origin.sx, origin.sy);
        drawer.style.setProperty("--activity-morph-panel-opacity", "0");
        drawer.style.setProperty("--activity-morph-pill-opacity", "1");

        body.style.willChange = "transform";
        body.style.transformOrigin = "top left";
        body.style.transform = `scale(${(1 / origin.sx).toFixed(6)}, ${(1 / origin.sy).toFixed(6)})`;

        content.style.willChange = "opacity, transform";
        content.style.opacity = "0";
        content.style.transform = "translateY(10px)";

        if (pill) {
          pill.style.willChange = "opacity, transform";
          pill.style.opacity = "1";
          setPillTransform(origin.sx, origin.sy);
        }
        if (externalPill) {
          externalPill.style.willChange = "opacity";
          externalPill.style.opacity = "0";
          externalPill.style.pointerEvents = "none";
        }

        cancelTweenRef.current = runTween(
          motion.openMs,
          (raw) => {
            const p = (() => {
              const split = 0.6;
              if (raw <= split) {
                const t = clamp(raw / split, 0, 1);
                return easeOutCubic(t) * 0.92;
              }
              const t = clamp((raw - split) / (1 - split), 0, 1);
              return 0.92 + easeOutBack(t, motion.overshoot) * 0.08;
            })();

            const translateX = origin.dx * (1 - p);
            const translateY = origin.dy * (1 - p);
            const scaleX = origin.sx + (1 - origin.sx) * p;
            const scaleY = origin.sy + (1 - origin.sy) * p;
            const shapeP = easeInOutCubic(raw);
            const radiusScreen =
              originCapsuleRadiusScreen + (computedRadius - originCapsuleRadiusScreen) * shapeP;

            drawer.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${scaleX}, ${scaleY})`;
            setShellRadius(radiusScreen, scaleX, scaleY);

            const materialRaw = clamp((raw - 0.06) / 0.28, 0, 1);
            const materialP = easeOutCubic(materialRaw);
            drawer.style.setProperty("--activity-morph-panel-opacity", materialP.toFixed(3));
            drawer.style.setProperty("--activity-morph-pill-opacity", (1 - materialP).toFixed(3));

            const invScaleX = clamp(1 / Math.max(0.01, scaleX), 0.01, 100);
            const invScaleY = clamp(1 / Math.max(0.01, scaleY), 0.01, 100);
            body.style.transform = `scale(${invScaleX.toFixed(6)}, ${invScaleY.toFixed(6)})`;

            setPillTransform(scaleX, scaleY);
            if (pill) {
              const pillOpacity = clamp(1 - materialP, 0, 1);
              pill.style.opacity = pillOpacity.toFixed(3);
            }

            const contentRaw = clamp((raw - 0.09) / 0.32, 0, 1);
            const contentP = easeOutCubic(contentRaw);
            content.style.opacity = contentP.toFixed(3);
            content.style.transform = `translateY(${((1 - contentP) * 10).toFixed(2)}px)`;
          },
          () => {
            cancelTweenRef.current = null;
            drawer.style.willChange = "";
            drawer.style.transformOrigin = "";
            drawer.style.transform = "";
            drawer.style.borderRadius = "";
            drawer.style.removeProperty("--activity-morph-panel-opacity");
            drawer.style.removeProperty("--activity-morph-pill-opacity");
            drawer.style.removeProperty("--activity-morph-pill-bg");
            drawer.style.removeProperty("--activity-morph-pill-border");
            drawer.style.removeProperty("--activity-morph-pill-shadow");
            body.style.willChange = "";
            body.style.transformOrigin = "";
            body.style.transform = "";
            content.style.willChange = "";
            content.style.opacity = "";
            content.style.transform = "";
            if (pill) {
              pill.style.willChange = "";
              pill.style.opacity = "";
              pill.style.transformOrigin = "";
              pill.style.transform = "";
              pill.style.padding = "";
              pill.style.gap = "";
              pill.style.borderWidth = "";
              pill.style.borderStyle = "";
              pill.style.borderColor = "";
              pill.style.fontFamily = "";
              pill.style.fontSize = "";
              pill.style.fontWeight = "";
              pill.style.letterSpacing = "";
              pill.style.textTransform = "";
              pill.style.lineHeight = "";
            }
            if (externalPill) {
              externalPill.style.willChange = "";
              externalPill.style.opacity = "";
              externalPill.style.pointerEvents = "";
            }
          },
          morphDelayMs
        );
        return;
      }

      if (isClosing) {
        stopAnimation();
        syncGhostPillWithExternal();
        syncPillMaterialVars();
        drawer.style.willChange = "transform, border-radius, opacity";
        drawer.style.transformOrigin = "top left";
        drawer.style.setProperty("--activity-morph-panel-opacity", "1");
        drawer.style.setProperty("--activity-morph-pill-opacity", "0");
        body.style.willChange = "transform";
        body.style.transformOrigin = "top left";
        content.style.willChange = "opacity, transform";
        if (pill) {
          pill.style.willChange = "opacity, transform";
          pill.style.opacity = "0";
          setPillTransform(1, 1);
        }
        if (externalPill) {
          externalPill.style.willChange = "opacity";
          externalPill.style.opacity = "0";
          externalPill.style.pointerEvents = "none";
        }

        closeFallbackTimerRef.current = window.setTimeout(() => {
          if (hasNotifiedClosedRef.current) return;
          stopAnimation();
          drawer.style.willChange = "";
          body.style.willChange = "";
          content.style.willChange = "";
          if (pill) {
            pill.style.willChange = "";
          }
          if (externalPill) {
            externalPill.style.willChange = "";
            externalPill.style.opacity = "";
          }
          notifyClosed();
        }, motion.closeMs + 240);

        cancelTweenRef.current = runTween(
          motion.closeMs,
          (raw) => {
            const fadeRaw = clamp(raw / 0.26, 0, 1);
            const fadeP = 1 - easeOutCubic(fadeRaw);
            content.style.opacity = fadeP.toFixed(3);
            content.style.transform = `translateY(${((1 - fadeP) * 8).toFixed(2)}px)`;

            const shellRaw = clamp(raw, 0, 1);
            const p = easeInOutCubic(shellRaw);

            const translateX = origin.dx * p;
            const translateY = origin.dy * p;
            const scaleX = 1 + (origin.sx - 1) * p;
            const scaleY = 1 + (origin.sy - 1) * p;
            const shapeP = easeInOutCubic(shellRaw);
            const radiusScreen =
              computedRadius + (originCapsuleRadiusScreen - computedRadius) * shapeP;

            drawer.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${scaleX}, ${scaleY})`;
            setShellRadius(radiusScreen, scaleX, scaleY);

            const emergeRaw = clamp((shellRaw - 0.18) / 0.46, 0, 1);
            const emerge = easeOutCubic(emergeRaw);
            drawer.style.setProperty("--activity-morph-panel-opacity", (1 - emerge).toFixed(3));
            drawer.style.setProperty("--activity-morph-pill-opacity", emerge.toFixed(3));

            const invScaleX = clamp(1 / Math.max(0.01, scaleX), 0.01, 100);
            const invScaleY = clamp(1 / Math.max(0.01, scaleY), 0.01, 100);
            body.style.transform = `scale(${invScaleX.toFixed(6)}, ${invScaleY.toFixed(6)})`;

            setPillTransform(scaleX, scaleY);
            if (pill) {
              const handoffRaw = clamp((shellRaw - 0.76) / 0.2, 0, 1);
              const handoffP = easeOutCubic(handoffRaw);
              pill.style.opacity = (emerge * (1 - handoffP)).toFixed(3);
              if (externalPill) {
                externalPill.style.opacity = handoffP.toFixed(3);
              }
            }
          },
          () => {
            stopAnimation();
            cancelTweenRef.current = null;
            drawer.style.willChange = "";
            body.style.willChange = "";
            content.style.willChange = "";
            if (pill) {
              pill.style.willChange = "";
            }
            if (externalPill) {
              externalPill.style.willChange = "";
              externalPill.style.opacity = "1";
              externalPill.style.pointerEvents = "none";
            }
            drawer.style.opacity = "0";
            window.setTimeout(() => notifyClosed(), 0);
            window.setTimeout(() => {
              if (!externalPill) return;
              externalPill.style.opacity = "";
              externalPill.style.pointerEvents = "";
            }, 120);
          }
        );
      }
    };

    startAnimation();

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      stopAnimation();
    };
  }, [isOpen, isClosing, originRect]);

  if (!isOpen && !isClosing) return null;
  return (
    <div
      className={`activity-backdrop${isClosing ? " closing" : isEntering ? "" : " open"}${
        isEntering ? " entering" : ""
      }`}
      data-qa="qa:drawer:activity-backdrop"
      onClick={onClose}
    >
      <aside
        className={`activity-drawer${isClosing ? " closing" : isEntering ? "" : " open"}${
          isEntering ? " entering" : ""
        }`}
        data-qa="qa:drawer:activity"
        ref={drawerRef}
        onClick={(event) => event.stopPropagation()}
      >
        {pillContent ? (
          <div className="activity-drawer-pill-ghost" ref={pillRef} aria-hidden="true">
            {pillContent}
          </div>
        ) : null}
        <div className="activity-drawer-body" ref={bodyRef}>
          <div className="activity-drawer-content" ref={contentRef}>
            {children}
          </div>
        </div>
      </aside>
    </div>
  );
}
