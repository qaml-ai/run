import { useEffect, useRef, type RefObject } from "react";

/**
 * Shared animation lifecycle for Art Motif Lab motifs.
 *
 * Every motif in the lab drives its rendering through this hook so the whole
 * page shares one set of performance guarantees:
 *
 * - single requestAnimationFrame loop per motif, cancelled the moment the
 *   motif can't be seen (scrolled offscreen, hidden tab) or is paused
 * - delta-time clamping so background tabs / long frames never produce jumps
 * - optional fps cap (battery control) via frame accumulator
 * - prefers-reduced-motion: the loop never starts; `renderStill` paints one
 *   beautiful static frame instead
 * - ResizeObserver-driven sizing with a devicePixelRatio ceiling
 * - live frame-time telemetry published to `window.__motifPerf` for the lab's
 *   comparison HUD
 */

export type MotifPerf = {
  fps: number;
  frameMs: number;
  running: boolean;
};

declare global {
  interface Window {
    __motifPerf?: Record<string, MotifPerf>;
  }
}

export type MotifLoopOptions = {
  /** Stable identifier used for the perf HUD. */
  slug: string;
  /** Element observed for visibility + sizing (usually the canvas wrapper). */
  containerRef: RefObject<HTMLElement | null>;
  /** External pause control (lab-level play/pause). */
  paused?: boolean;
  /** Max device pixel ratio to render at. Default 2. */
  maxDpr?: number;
  /** Optional frames-per-second ceiling (e.g. 30 for battery mode). */
  fpsCap?: number;
  /**
   * Called whenever the container size or DPR changes, before the next frame.
   * Receives CSS-pixel dimensions plus the clamped DPR.
   */
  onResize: (width: number, height: number, dpr: number) => void;
  /** Advance + draw one frame. `dt` is clamped seconds, `elapsed` total seconds. */
  onFrame: (dt: number, elapsed: number) => void;
  /**
   * Paint a single static frame (reduced motion, or paint-before-first-tick).
   * Should be a composed, presentable image — not a blank canvas.
   */
  renderStill: (elapsed: number) => void;
};

const MAX_DT = 1 / 20; // clamp long frames to 50ms of simulated time

export function useMotifLoop({
  slug,
  containerRef,
  paused = false,
  maxDpr = 2,
  fpsCap,
  onResize,
  onFrame,
  renderStill,
}: MotifLoopOptions) {
  const pausedRef = useRef(paused);
  const wakeRef = useRef<() => void>(() => undefined);
  const callbacksRef = useRef({ onResize, onFrame, renderStill });
  callbacksRef.current = { onResize, onFrame, renderStill };

  // Callback refs intentionally stay out of the lifecycle effect so inline
  // render functions do not restart observers and animation state. Re-run
  // wake after every React commit, though: when the loop is paused or reduced
  // motion is active, wake paints a fresh still with the latest visual props.
  useEffect(() => {
    pausedRef.current = paused;
    wakeRef.current();
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    let elapsed = 0;
    let previous = 0;
    let accumulator = 0;
    let inView = false;
    let sized = false;
    let docVisible = document.visibilityState === "visible";
    let lastWidth = 0;
    let lastHeight = 0;
    let lastDpr = 0;

    // rolling perf telemetry (updated roughly every 30 frames)
    let perfFrames = 0;
    let perfTime = 0;
    let perfWindowStart = 0;
    const perf: MotifPerf = { fps: 0, frameMs: 0, running: false };
    window.__motifPerf = { ...window.__motifPerf, [slug]: perf };

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const measure = () => {
      const bounds = container.getBoundingClientRect();
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
      if (width === lastWidth && height === lastHeight && dpr === lastDpr) {
        return;
      }
      lastWidth = width;
      lastHeight = height;
      lastDpr = dpr;
      sized = true;
      callbacksRef.current.onResize(width, height, dpr);
      callbacksRef.current.renderStill(elapsed);
    };

    const shouldRun = () =>
      sized &&
      inView &&
      docVisible &&
      !pausedRef.current &&
      !reducedMotion.matches;

    const tick = (now: number) => {
      frame = 0;
      if (!shouldRun()) {
        perf.running = false;
        return;
      }
      const rawDt = (now - previous) / 1000;
      previous = now;
      const dt = Math.min(Math.max(rawDt, 0), MAX_DT);

      let render = true;
      if (fpsCap && fpsCap > 0) {
        accumulator += rawDt * 1000;
        const interval = 1000 / fpsCap;
        if (accumulator >= interval - 0.5) {
          accumulator %= interval;
        } else {
          render = false;
        }
      }

      if (render) {
        elapsed += dt;
        const start = performance.now();
        callbacksRef.current.onFrame(dt, elapsed);
        const cost = performance.now() - start;
        if (perfFrames === 0) perfWindowStart = start;
        perfFrames += 1;
        perfTime += cost;
        if (perfFrames >= 30) {
          const span = performance.now() - perfWindowStart;
          perf.fps = Math.round((perfFrames / Math.max(span, 1)) * 1000);
          perf.frameMs = perfTime / perfFrames;
          perf.running = true;
          perfFrames = 0;
          perfTime = 0;
        }
      }

      frame = requestAnimationFrame(tick);
    };

    const wake = () => {
      if (frame !== 0) return;
      if (!shouldRun()) {
        perf.running = false;
        if (sized) callbacksRef.current.renderStill(elapsed);
        return;
      }
      previous = performance.now();
      frame = requestAnimationFrame(tick);
    };
    wakeRef.current = wake;

    const resizeObserver = new ResizeObserver(() => {
      measure();
      wake();
    });
    resizeObserver.observe(container);

    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        inView = entry.isIntersecting;
        if (inView && !sized) measure();
        wake();
      },
      { rootMargin: "96px 0px" },
    );
    intersectionObserver.observe(container);

    const handleVisibility = () => {
      docVisible = document.visibilityState === "visible";
      wake();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    const handleReducedMotion = () => {
      if (sized) callbacksRef.current.renderStill(elapsed);
      wake();
    };
    reducedMotion.addEventListener("change", handleReducedMotion);

    measure();
    wake();

    return () => {
      cancelAnimationFrame(frame);
      frame = 0;
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
      reducedMotion.removeEventListener("change", handleReducedMotion);
      wakeRef.current = () => undefined;
      if (window.__motifPerf) delete window.__motifPerf[slug];
    };
  }, [slug, containerRef, maxDpr, fpsCap]);
}
