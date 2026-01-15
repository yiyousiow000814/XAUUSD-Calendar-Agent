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
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodyInnerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const cancelTweenRef = useRef<(() => void) | null>(null);
  const closeFallbackTimerRef = useRef<number | null>(null);
  const morphCleanupTimerRef = useRef<number | null>(null);
  const hasNotifiedClosedRef = useRef(false);
  const onClosedRef = useRef<ActivityDrawerProps["onClosed"]>(onClosed);

  useLayoutEffect(() => {
    onClosedRef.current = onClosed;
  }, [onClosed]);

  useLayoutEffect(() => {
    const backdrop = backdropRef.current;
    const drawer = drawerRef.current;
    const body = bodyRef.current;
    const bodyInner = bodyInnerRef.current;
    const content = contentRef.current;
    const pill = pillRef.current;
    const externalPill = externalPillRef?.current ?? null;
    if (!backdrop || !drawer || !body || !bodyInner || !content) return;

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
      ? { openMs: 260, closeMs: 260, overshoot: 1.02 }
      : { openMs: 600, closeMs: 520, overshoot: 1.12 };

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
      if (morphCleanupTimerRef.current) {
        window.clearTimeout(morphCleanupTimerRef.current);
        morphCleanupTimerRef.current = null;
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

    const easeOutSine = (t: number) => Math.sin((t * Math.PI) / 2);
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    const lastBackdropOpacityRef = { current: NaN as number };

    const setBackdrop = (dimOpacity: number) => {
      const opacity = clamp(dimOpacity, 0, 1);

      if (
        !Number.isFinite(lastBackdropOpacityRef.current) ||
        Math.abs(opacity - lastBackdropOpacityRef.current) > 0.003
      ) {
        lastBackdropOpacityRef.current = opacity;
        backdrop.style.setProperty("--activity-backdrop-opacity", String(Math.round(opacity * 1000) / 1000));
      }
    };

    const lastClipRadiusRef = { current: "" };

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

        const clipRadiusPx = clamp(Math.min(rx, ry) + 1.2, 0, 999);
        const clipRadius = `${clipRadiusPx.toFixed(2)}px`;
        if (clipRadius !== lastClipRadiusRef.current) {
          lastClipRadiusRef.current = clipRadius;
          drawer.style.setProperty("--activity-clip-radius", clipRadius);
        }
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
        drawer.dataset.animating = "true";
        setBackdrop(0);

        syncGhostPillWithExternal();
        syncPillMaterialVars();

        drawer.style.willChange = "transform, border-radius, opacity";
        drawer.style.transformOrigin = "top left";
        drawer.style.transform = `translate3d(${origin.dx}px, ${origin.dy}px, 0) scale(${origin.sx}, ${origin.sy})`;
        setShellRadius(originCapsuleRadiusScreen, origin.sx, origin.sy);
        drawer.style.setProperty("--activity-morph-panel-opacity", "0");
        drawer.style.setProperty("--activity-morph-pill-opacity", "1");

        bodyInner.style.willChange = "transform";
        bodyInner.style.transformOrigin = "top left";
        bodyInner.style.transform = `scale(${(1 / origin.sx).toFixed(6)}, ${(1 / origin.sy).toFixed(6)})`;

        content.style.willChange = "opacity, transform, filter";
        content.style.opacity = "0";
        content.style.transform = "translateY(10px)";
        content.style.filter = prefersReducedMotion ? "none" : "blur(5px)";

        if (pill) {
          pill.style.willChange = "opacity, transform, filter";
          pill.style.opacity = "1";
          pill.style.filter = prefersReducedMotion ? "none" : "blur(2px)";
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
            const shellP = easeOutSine(raw);
            const overshootBump = prefersReducedMotion
              ? 0
              : (easeOutBack(raw, motion.overshoot) - shellP) * 0.02;

            const translateX = origin.dx * (1 - shellP);
            const translateY = origin.dy * (1 - shellP);
            const scaleX = origin.sx + (1 - origin.sx) * shellP + overshootBump;
            const scaleY = origin.sy + (1 - origin.sy) * shellP + overshootBump;
            const shapeP = easeInOutCubic(shellP);
            const radiusScreen =
              originCapsuleRadiusScreen + (computedRadius - originCapsuleRadiusScreen) * shapeP;

            drawer.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${scaleX}, ${scaleY})`;
            setShellRadius(radiusScreen, scaleX, scaleY);

            const dimP = Math.pow(shellP, 0.9);
            setBackdrop(dimP);

            const materialRaw = clamp((raw - 0.06) / 0.28, 0, 1);
            const materialP = easeOutCubic(materialRaw);
            drawer.style.setProperty("--activity-morph-panel-opacity", materialP.toFixed(3));
            drawer.style.setProperty("--activity-morph-pill-opacity", (1 - materialP).toFixed(3));

            const invScaleX = clamp(1 / Math.max(0.01, scaleX), 0.01, 100);
            const invScaleY = clamp(1 / Math.max(0.01, scaleY), 0.01, 100);
            bodyInner.style.transform = `scale(${invScaleX.toFixed(6)}, ${invScaleY.toFixed(6)})`;

            setPillTransform(scaleX, scaleY);
            if (pill) {
              const pillOpacity = clamp(1 - materialP, 0, 1);
              pill.style.opacity = pillOpacity.toFixed(3);
              if (!prefersReducedMotion) {
                // Keep the pill a touch softer during the early morph.
                pill.style.filter = `blur(${(pillOpacity * 2).toFixed(2)}px)`;
              }
            }

            // Keep early frames from reading "too crisp" while the drawer is still small.
            const contentRaw = clamp((raw - 0.12) / 0.36, 0, 1);
            const contentP = easeOutCubic(contentRaw);
            content.style.opacity = contentP.toFixed(3);
            content.style.transform = `translateY(${((1 - contentP) * 10).toFixed(2)}px)`;
            if (!prefersReducedMotion) {
              content.style.filter = `blur(${((1 - contentP) * 5).toFixed(2)}px)`;
            }
          },
          () => {
            cancelTweenRef.current = null;
            drawer.style.willChange = "";
            drawer.style.transformOrigin = "";
            drawer.style.transform = "";
            drawer.style.borderRadius = "";
            drawer.style.removeProperty("--activity-clip-radius");

            setBackdrop(1);

            if (morphCleanupTimerRef.current) {
              window.clearTimeout(morphCleanupTimerRef.current);
            }
            morphCleanupTimerRef.current = window.setTimeout(() => {
              morphCleanupTimerRef.current = null;
              delete drawer.dataset.animating;
              drawer.style.removeProperty("--activity-morph-panel-opacity");
              drawer.style.removeProperty("--activity-morph-pill-opacity");
              drawer.style.removeProperty("--activity-morph-pill-bg");
              drawer.style.removeProperty("--activity-morph-pill-border");
              drawer.style.removeProperty("--activity-morph-pill-shadow");
              bodyInner.style.willChange = "";
              bodyInner.style.transformOrigin = "";
              bodyInner.style.transform = "";
              content.style.willChange = "";
              content.style.opacity = "";
              content.style.transform = "";
              content.style.filter = "";
              if (pill) {
                pill.style.willChange = "";
                pill.style.opacity = "";
                pill.style.transformOrigin = "";
                pill.style.transform = "";
                pill.style.filter = "";
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
            }, 0);
          },
          morphDelayMs
        );
        return;
      }

      if (isClosing) {
        stopAnimation();
        drawer.dataset.animating = "true";
        setBackdrop(1);
        syncGhostPillWithExternal();
        syncPillMaterialVars();
        drawer.style.willChange = "transform, border-radius, opacity";
        drawer.style.transformOrigin = "top left";
        drawer.style.setProperty("--activity-morph-panel-opacity", "1");
        drawer.style.setProperty("--activity-morph-pill-opacity", "0");
        bodyInner.style.willChange = "transform";
        bodyInner.style.transformOrigin = "top left";
        content.style.willChange = "opacity, transform, filter";
        content.style.filter = "";
        if (pill) {
          pill.style.willChange = "opacity, transform, filter";
          pill.style.opacity = "0";
          pill.style.filter = "";
          setPillTransform(1, 1);
        }
        if (externalPill) {
          externalPill.style.willChange = "opacity";
          externalPill.style.opacity = "0";
          externalPill.style.visibility = "hidden";
          externalPill.style.pointerEvents = "none";
        }

        closeFallbackTimerRef.current = window.setTimeout(() => {
          if (hasNotifiedClosedRef.current) return;
          stopAnimation();
          delete drawer.dataset.animating;
          setBackdrop(0);
          drawer.style.willChange = "";
          bodyInner.style.willChange = "";
          content.style.willChange = "";
          if (pill) {
            pill.style.willChange = "";
          }
          if (externalPill) {
            externalPill.style.willChange = "";
            externalPill.style.opacity = "";
            externalPill.style.visibility = "";
          }
          notifyClosed();
        }, motion.closeMs + 240);

        cancelTweenRef.current = runTween(
          motion.closeMs,
          (raw) => {
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

            const contentFadeRaw = clamp((shellRaw - 0.08) / 0.62, 0, 1);
            const contentFadeP = easeInOutCubic(contentFadeRaw);
            // Bring the pill back only after the drawer is past ~50% collapsed,
            // then gradually sharpen as it approaches the final capsule size.
            // Keep the external pill hidden longer to avoid a "double pill" during the handoff.
            const ghostRaw = clamp((shellRaw - 0.5) / 0.5, 0, 1);
            const ghostP = easeOutCubic(ghostRaw);

            // Avoid a "double header" (pill label + blurred content title) once the pill is back in view.
            const contentOpacity = (1 - contentFadeP) * (1 - ghostP);
            content.style.opacity = contentOpacity.toFixed(3);
            content.style.transform = `translateY(${(contentFadeP * 10).toFixed(2)}px)`;
            if (!prefersReducedMotion) {
              content.style.filter = `blur(${(contentFadeP * 4 * (1 - ghostP)).toFixed(2)}px)`;
            }

            drawer.style.setProperty("--activity-morph-panel-opacity", (1 - ghostP).toFixed(3));
            drawer.style.setProperty("--activity-morph-pill-opacity", ghostP.toFixed(3));

            const backdropP = Math.pow(1 - easeInOutCubic(shellRaw), 0.85);
            setBackdrop(backdropP);

            const invScaleX = clamp(1 / Math.max(0.01, scaleX), 0.01, 100);
            const invScaleY = clamp(1 / Math.max(0.01, scaleY), 0.01, 100);
            bodyInner.style.transform = `scale(${invScaleX.toFixed(6)}, ${invScaleY.toFixed(6)})`;

            setPillTransform(scaleX, scaleY);
            if (pill) {
              const handoffRaw = clamp((shellRaw - 0.9) / 0.1, 0, 1);
              const handoffP = easeOutCubic(handoffRaw);
              // Fade and sharpen the pill gradually so it doesn't read "too crisp" early in the close.
              // Keep the pill label faint/soft early in the close (e.g. around t=120ms),
              // and let it sharpen closer to the final capsule size.
              const pillCrispRaw = clamp((ghostP - 0.35) / 0.65, 0, 1);
              const pillCrispP = easeOutCubic(pillCrispRaw);
              const pillOpacity = ghostP * (1 - handoffP) * (0.15 + 0.85 * pillCrispP);
              pill.style.opacity = pillOpacity.toFixed(3);
              if (!prefersReducedMotion) {
                pill.style.filter = `blur(${((1 - pillCrispP) * 5).toFixed(2)}px)`;
              }
              if (externalPill) {
                externalPill.style.visibility = handoffP > 0.02 ? "visible" : "hidden";
                externalPill.style.opacity = handoffP.toFixed(3);
              }
            }
          },
          () => {
            stopAnimation();
            cancelTweenRef.current = null;
            delete drawer.dataset.animating;
            drawer.style.willChange = "";
            bodyInner.style.willChange = "";
            content.style.willChange = "";
            content.style.filter = "";
            drawer.style.removeProperty("--activity-clip-radius");
            setBackdrop(0);
            if (pill) {
              pill.style.willChange = "";
              pill.style.filter = "";
            }
            if (externalPill) {
              externalPill.style.willChange = "";
              externalPill.style.visibility = "visible";
              externalPill.style.opacity = "1";
              externalPill.style.pointerEvents = "none";
            }
            drawer.style.opacity = "0";
            window.setTimeout(() => notifyClosed(), 0);
            window.setTimeout(() => {
              if (!externalPill) return;
              externalPill.style.opacity = "";
              externalPill.style.visibility = "";
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
      delete drawer.dataset.animating;
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
      ref={backdropRef}
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
          <div className="activity-drawer-body-inner" ref={bodyInnerRef}>
            <div className="activity-drawer-content" ref={contentRef}>
              {children}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
