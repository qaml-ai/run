import { memo, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { useMotifLoop } from "@/hooks/use-motif-loop";
import { DitherBuffer, hash2, heroPalette } from "./core";
import type { DitherSurfaceProps } from "./aurora";

/**
 * DitherLiquid — adopted Stream brand fields (from the motif port lab).
 * The brand metaphor made literal: a Stream is moving water. These fields
 * TRANSLATE, which the chunky quantized medium renders like classic
 * pixel-game water.
 *
 * - current: a river seen from the bank — laminar shear flow, glints riding
 *            the fast mid-channel, two standing eddies. Highlights are
 *            deliberately capped below the palette's brightest step so the
 *            surface stays calm under copy.
 *            Role: the Stream hero surface.
 * - swell:   three layered ocean rollers crossing the frame, foam sparking
 *            on steep crests. Role: footer bands, section transitions.
 *
 * Same anti-flicker block architecture as DitherAurora.
 */

export type DitherLiquidVariant = "current" | "swell";

const CELL = 5;
const SUPER: Record<DitherLiquidVariant, number> = { current: 2, swell: 3 };
const QSTEPS = 13;
/** Ceiling for current's field — keeps the top palette step rare. */
const CURRENT_MAX = 0.72;

type State = {
  buf: DitherBuffer;
  jit: Float32Array;
  bCols: number;
  bRows: number;
  w: number;
  h: number;
  time: number;
};

function ensureBlocks(s: State, sup: number) {
  const bCols = Math.ceil(s.buf.cols / sup);
  const bRows = Math.ceil(s.buf.rows / sup);
  if (s.bCols === bCols && s.bRows === bRows && s.jit.length === bCols * bRows) {
    return;
  }
  s.bCols = bCols;
  s.bRows = bRows;
  s.jit = new Float32Array(bCols * bRows);
  for (let by = 0; by < bRows; by++) {
    for (let bx = 0; bx < bCols; bx++) {
      s.jit[by * bCols + bx] = (hash2(bx * 7 + 1, by * 13 + 5) - 0.5) * (1.2 / QSTEPS);
    }
  }
}

function render(s: State, variant: DitherLiquidVariant, seed: number) {
  const { cols, rows, field } = s.buf;
  const sup = SUPER[variant];
  ensureBlocks(s, sup);
  const { bCols, bRows, jit } = s;
  const t = s.time + seed * 39.17;
  const S = 3.0 / Math.max(cols, rows);

  let surf: Float32Array | null = null;
  if (variant === "swell") {
    surf = new Float32Array(bCols * 3);
    for (let k = 0; k < 3; k++) {
      const base = rows * (0.32 + 0.21 * k);
      const amp = rows * (0.055 + 0.028 * k);
      const spd = 0.3 + 0.16 * k;
      const freq = (1.2 + 0.3 * k) * S * sup;
      for (let bx = 0; bx < bCols; bx++) {
        const ph = bx * freq;
        surf[k * bCols + bx] =
          base +
          amp * Math.sin(ph - t * spd + k * 1.9) +
          amp * 0.5 * Math.sin(ph * 2.3 - t * spd * 1.6 + k);
      }
    }
  }

  for (let by = 0; by < bRows; by++) {
    const yC = (by + 0.5) * sup;
    const yn = yC / rows;
    for (let bx = 0; bx < bCols; bx++) {
      const xC = (bx + 0.5) * sup;
      let v = 0;

      if (variant === "current") {
        // parabolic channel profile: fastest water mid-frame
        const prof = 4 * yn * (1 - yn);
        const flowX = xC * S * 0.55 - t * (0.35 + 0.85 * prof);
        const band = Math.sin(
          flowX * 2.0 + 1.1 * Math.sin(yC * S * 3.0 + 0.4 * Math.sin(flowX * 0.9)),
        );
        const glint = Math.pow(
          0.5 + 0.5 * Math.sin(flowX * 3.7 + yC * S * 1.2 + 2.0),
          6,
        );
        v =
          0.1 +
          0.24 * Math.pow(0.5 + 0.5 * band, 1.8) +
          0.15 * glint * prof;
        for (let e = 0; e < 2; e++) {
          const ex = cols * (e === 0 ? 0.3 : 0.76);
          const ey = rows * (e === 0 ? 0.36 : 0.62);
          const er = Math.min(cols, rows) * 0.13;
          const dx = (xC - ex) / er;
          const dy = (yC - ey) / er;
          const d2 = dx * dx + dy * dy;
          if (d2 < 4) {
            const swirl = Math.sin(
              2 * Math.atan2(dy, dx) + Math.sqrt(d2) * 4.5 - t * (e === 0 ? 1.0 : -0.8),
            );
            v += 0.13 * swirl * Math.exp(-d2 * 0.8);
          }
        }
        if (v > CURRENT_MAX) v = CURRENT_MAX;
      } else {
        v = 0.035; // sky
        for (let k = 0; k < 3; k++) {
          const sy = surf![k * bCols + bx];
          if (yC < sy) continue;
          const depth = (yC - sy) / rows;
          const body = 0.09 + 0.06 * k;
          const surface = Math.exp(-depth * 9) * (0.3 + 0.09 * k);
          const ahead = surf![k * bCols + Math.min(bCols - 1, bx + 1)];
          const slope = Math.abs(ahead - sy) / sup;
          const foam =
            slope > 0.4 && depth < 0.035 && hash2(bx * 3 + k, by * 5) > 0.45
              ? 0.26
              : 0;
          v = body + surface + foam;
        }
      }

      v = Math.round((v + jit[by * bCols + bx]) * QSTEPS) / QSTEPS;
      if (v < 0) v = 0;

      const x0 = bx * sup;
      const y0 = by * sup;
      const x1 = Math.min(cols, x0 + sup);
      const y1 = Math.min(rows, y0 + sup);
      for (let y = y0; y < y1; y++) {
        const base = y * cols;
        for (let x = x0; x < x1; x++) field[base + x] = v;
      }
    }
  }
}

function DitherLiquidInner({
  variant,
  theme = "dark",
  paused = false,
  className,
  seed = 0,
  strength = 1,
}: DitherSurfaceProps & { variant: DitherLiquidVariant }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<State | null>(null);
  if (!stateRef.current) {
    stateRef.current = {
      buf: new DitherBuffer(CELL),
      jit: new Float32Array(0),
      bCols: 0,
      bRows: 0,
      w: 1,
      h: 1,
      time: 0,
    };
  }

  const paint = useCallback(
    (dt: number) => {
      const s = stateRef.current;
      const ctx = canvasRef.current?.getContext("2d");
      if (!s || !ctx) return;
      s.time += dt;
      render(s, variant, seed);
      s.buf.flush(ctx, s.w, s.h, heroPalette(theme, strength));
    },
    [variant, theme, seed, strength],
  );

  useMotifLoop({
    slug: `dither-liquid-${variant}-${seed}`,
    containerRef,
    paused,
    maxDpr: 2,
    onResize: (width, height, dpr) => {
      const canvas = canvasRef.current;
      const s = stateRef.current;
      if (!canvas || !s) return;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
      s.w = width;
      s.h = height;
      s.buf.resize(width, height);
      s.bCols = 0;
      if (s.time === 0) s.time = 16;
    },
    onFrame: (dt) => paint(dt),
    renderStill: () => paint(0),
  });

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative isolate size-full overflow-hidden",
        theme === "light" ? "bg-[#f6f4ee]" : "bg-[#0b0b0c]",
        className,
      )}
    >
      <canvas ref={canvasRef} className="absolute inset-0 block size-full" aria-hidden />
    </div>
  );
}

export const DitherLiquid = memo(DitherLiquidInner);
