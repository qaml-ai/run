import { memo, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { useMotifLoop } from "@/hooks/use-motif-loop";
import { DitherBuffer, hash2, heroPalette, type HeroTheme } from "./core";

/**
 * DitherAurora — adopted Stream brand fields (from the motif port lab).
 *
 * - silk:    long horizontal bands warped by a slow phrase + focal bloom.
 *            Role: section banners and page headers.
 * - curtain: aurora rays hanging from a wavy top edge, swaying slowly.
 *            Role: empty states, transitions, tall moment-pieces.
 *
 * Anti-flicker architecture: the field is computed on a SUPER-cell block
 * grid, each block's value is quantized to QSTEPS discrete levels, and the
 * only randomness is a STATIC per-block jitter. A block holds one stable
 * dither pattern until its level actually steps. No per-frame grain.
 */

export type DitherAuroraVariant = "silk" | "curtain";

export type DitherSurfaceProps = {
  theme?: HeroTheme;
  paused?: boolean;
  className?: string;
  /** Phase seed so multiple instances don't sync. */
  seed?: number;
  /** Palette contrast 0..1 — use TONES.ambient under copy, TONES.full bare. */
  strength?: number;
};

const CELL = 5;
const SUPER: Record<DitherAuroraVariant, number> = { silk: 2, curtain: 3 };
const QSTEPS = 13;

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

function render(s: State, variant: DitherAuroraVariant, seed: number) {
  const { cols, rows, field } = s.buf;
  const sup = SUPER[variant];
  ensureBlocks(s, sup);
  const { bCols, bRows, jit } = s;
  const t = s.time + seed * 47.31;
  const S = 3.0 / Math.max(cols, rows);

  let tops: Float32Array | null = null;
  let lens: Float32Array | null = null;
  let shim: Float32Array | null = null;
  if (variant === "curtain") {
    tops = new Float32Array(bCols);
    lens = new Float32Array(bCols);
    shim = new Float32Array(bCols);
    for (let bx = 0; bx < bCols; bx++) {
      const sx = (bx + 0.5) * sup * S;
      tops[bx] =
        rows *
        (0.08 +
          0.07 * Math.sin(sx * 2.6 + t * 0.21) +
          0.05 * Math.sin(sx * 5.3 - t * 0.13 + 1.4));
      lens[bx] = rows * (0.78 + 0.18 * Math.sin(sx * 3.4 + t * 0.09 + 2.2));
      const comb = Math.pow(
        0.5 + 0.5 * Math.sin(sx * 10.5 + 1.6 * Math.sin(sx * 2.9 + t * 0.24)),
        3,
      );
      shim[bx] =
        (0.18 + 0.95 * comb) * (0.86 + 0.14 * Math.sin(t * 0.55 + bx * 0.9));
    }
  }

  const phA = Math.sin(t * 0.14);
  const fx = cols * (0.62 + 0.1 * Math.sin(t * 0.05));
  const fy = rows * (0.42 + 0.12 * Math.cos(t * 0.041));
  const irx = 1 / (cols * 0.34);
  const iry = 1 / (rows * 0.55);

  for (let by = 0; by < bRows; by++) {
    const yC = (by + 0.5) * sup;
    for (let bx = 0; bx < bCols; bx++) {
      const xC = (bx + 0.5) * sup;
      let v = 0;

      if (variant === "silk") {
        const sx = xC * S;
        const sy = yC * S * 3.1;
        const warp =
          0.9 * Math.sin(sx * 0.8 + t * 0.11) +
          0.5 * Math.sin(sx * 1.7 - t * 0.07 + phA);
        const band = Math.sin(sy + warp + phA * 0.6);
        const band2 = Math.sin(sy * 0.53 - warp * 0.7 + t * 0.05 + 2.1);
        const dx = (xC - fx) * irx;
        const dy = (yC - fy) * iry;
        const bloom = Math.exp(-(dx * dx + dy * dy));
        v =
          0.1 +
          0.26 * Math.pow(Math.max(0, band), 1.6) +
          0.13 * Math.pow(Math.max(0, band2), 2) +
          0.22 * bloom;
      } else {
        const drop = (yC - tops![bx]) / lens![bx];
        v = 0.025;
        if (drop > 0) {
          const env = Math.max(0, 1 - drop);
          v += Math.pow(env, 1.35) * 0.62 * shim![bx] + Math.pow(env, 6) * 0.1;
        } else {
          v += Math.exp(drop * 4.5) * 0.3 * shim![bx];
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

function DitherAuroraInner({
  variant,
  theme = "dark",
  paused = false,
  className,
  seed = 0,
  strength = 1,
}: DitherSurfaceProps & { variant: DitherAuroraVariant }) {
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
    slug: `dither-aurora-${variant}-${seed}`,
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
      if (s.time === 0) s.time = 20;
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

export const DitherAurora = memo(DitherAuroraInner);
