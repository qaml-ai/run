/**
 * Dither design system — core toolkit.
 *
 * CANONICAL LOCATION. Every dithered brand surface (mission hero, Stream
 * liquids, camelCode stitches) renders through this one pipeline so the
 * whole site shares a single visual grammar: low-res intensity fields,
 * 8x8 Bayer ordered dithering into a 5-step palette, nearest-neighbor
 * upscale. Labs under /mission-hero-lab and /motif-port-lab import the
 * same code — prototypes and production never drift apart.
 */

/** 8x8 Bayer matrix, flattened row-major, values in (0, 1). */
export const BAYER8: Float32Array = (() => {
  let m: number[][] = [[0]];
  while (m.length < 8) {
    const n = m.length;
    const next: number[][] = Array.from({ length: n * 2 }, () =>
      new Array<number>(n * 2).fill(0),
    );
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + n] = v + 2;
        next[y + n][x] = v + 3;
        next[y + n][x + n] = v + 1;
      }
    }
    m = next;
  }
  const flat = new Float32Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) flat[y * 8 + x] = (m[y][x] + 0.5) / 64;
  }
  return flat;
})();

export type Palette = { rgb: Uint8Array; count: number };

export function makePalette(hexes: string[]): Palette {
  const rgb = new Uint8Array(hexes.length * 3);
  hexes.forEach((hex, i) => {
    const h = hex.replace("#", "");
    rgb[i * 3] = parseInt(h.slice(0, 2), 16);
    rgb[i * 3 + 1] = parseInt(h.slice(2, 4), 16);
    rgb[i * 3 + 2] = parseInt(h.slice(4, 6), 16);
  });
  return { rgb, count: hexes.length };
}

/** Dark theme: near-black ground → warm paper white. */
export const INK: Palette = makePalette([
  "#0b0b0c",
  "#2c2c31",
  "#6e6e77",
  "#b3b1aa",
  "#f4f2ea",
]);

/** Light theme: warm paper ground → near-black ink (the print grade). */
export const PAPER: Palette = makePalette([
  "#f6f4ee",
  "#c6c3ba",
  "#8a888f",
  "#3f3f45",
  "#111113",
]);

export type HeroTheme = "dark" | "light";

/**
 * Named contrast levels for the `strength` prop of every dither component.
 * - ambient: the adopted text-safe level — any surface with foreground copy
 * - full:    pure-art moments with no copy on top (dividers, empty states)
 */
export const TONES = {
  ambient: 0.4,
  full: 1,
} as const;

const fadedPaletteCache = new Map<string, Palette>();

/**
 * Theme palette, optionally faded: `strength` in (0, 1] mixes every color
 * toward the background by the same factor, so a busy pattern quiets down
 * uniformly — structure identical, contrast lower. 1 = full brand contrast.
 */
export function heroPalette(
  theme: HeroTheme | undefined,
  strength = 1,
): Palette {
  const base = theme === "light" ? PAPER : INK;
  if (strength >= 1) return base;
  const s = Math.max(0.05, Math.round(strength * 100) / 100);
  const key = `${theme ?? "dark"}:${s}`;
  const cached = fadedPaletteCache.get(key);
  if (cached) return cached;
  const rgb = new Uint8Array(base.rgb.length);
  const bg = [base.rgb[0], base.rgb[1], base.rgb[2]];
  for (let i = 0; i < base.count; i++) {
    for (let c = 0; c < 3; c++) {
      rgb[i * 3 + c] = Math.round(bg[c] + (base.rgb[i * 3 + c] - bg[c]) * s);
    }
  }
  const faded = { rgb, count: base.count };
  fadedPaletteCache.set(key, faded);
  return faded;
}

/** The custom display font, with Silkscreen as the until-loaded fallback. */
export const HERO_FONT_FAMILY = '"CamelCool", "Silkscreen", monospace';

/**
 * Low-resolution intensity buffer + ordered-dither presenter.
 * `field` holds one brightness float per cell; `flush` quantizes it through
 * the Bayer matrix into the palette and stretches it onto the target canvas.
 */
export class DitherBuffer {
  cell: number;
  cols = 0;
  rows = 0;
  field: Float32Array = new Float32Array(0);
  private lowres: HTMLCanvasElement | null = null;
  private lctx: CanvasRenderingContext2D | null = null;
  private img: ImageData | null = null;

  constructor(cell: number) {
    this.cell = cell;
  }

  resize(width: number, height: number) {
    this.cols = Math.max(8, Math.round(width / this.cell));
    this.rows = Math.max(8, Math.round(height / this.cell));
    this.field = new Float32Array(this.cols * this.rows);
    this.lowres = document.createElement("canvas");
    this.lowres.width = this.cols;
    this.lowres.height = this.rows;
    this.lctx = this.lowres.getContext("2d");
    this.img = this.lctx ? this.lctx.createImageData(this.cols, this.rows) : null;
  }

  flush(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    palette: Palette = INK,
  ) {
    const { img, lctx, lowres, cols, rows, field } = this;
    if (!img || !lctx || !lowres) return;
    const data = img.data;
    const rgb = palette.rgb;
    const n1 = palette.count - 1;
    let p = 0;
    for (let y = 0; y < rows; y++) {
      const by = (y & 7) << 3;
      for (let x = 0; x < cols; x++, p++) {
        let idx = 0;
        let v = field[p];
        if (v > 0) {
          if (v > 1) v = 1;
          const t = v * n1;
          const b = t | 0;
          idx = t - b > BAYER8[by | (x & 7)] ? b + 1 : b;
          if (idx > n1) idx = n1;
        }
        const o = p * 4;
        const c = idx * 3;
        data[o] = rgb[c];
        data[o + 1] = rgb[c + 1];
        data[o + 2] = rgb[c + 2];
        data[o + 3] = 255;
      }
    }
    lctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(lowres, 0, 0, cols, rows, 0, 0, width, height);
  }
}

export type Wordmark = {
  /** 0/1 per low-res cell. */
  mask: Float32Array;
  /** Font size (in low-res cells) that was actually used. */
  fontPx: number;
  /** Row range that contains glyph cells (for glitch bands etc.). */
  top: number;
  bottom: number;
};

/**
 * Rasterize a wordmark into a low-res 0/1 mask using the display font.
 * Call again once `document.fonts` resolves — before that the fallback font
 * renders, which is fine for the first few frames.
 */
export function rasterizeWordmark(
  cols: number,
  rows: number,
  text = "AI FOR ALL",
  centerY = 0.45,
  maxWidthFrac = 0.9,
  fontFamily = HERO_FONT_FAMILY,
  fontWeight = 400,
): Wordmark {
  const empty: Wordmark = {
    mask: new Float32Array(cols * rows),
    fontPx: 0,
    top: 0,
    bottom: 0,
  };
  if (typeof document === "undefined") return empty;

  // 3x supersampling: the display font has inline channels inside its
  // strokes; sampling glyph coverage per cell (instead of point-sampling
  // alpha) renders that detail faithfully at grid scale instead of
  // aliasing it into moiré checkers.
  const SS = 3;
  const canvas = document.createElement("canvas");
  canvas.width = cols * SS;
  canvas.height = rows * SS;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return empty;

  let fontPx = Math.round(rows * 0.3) * SS;
  const font = (px: number) => `${fontWeight} ${px}px ${fontFamily}`;
  ctx.font = font(fontPx);
  const w = ctx.measureText(text).width;
  if (w > 0) {
    fontPx = Math.max(
      6 * SS,
      Math.min(
        Math.round(rows * 0.3) * SS,
        Math.floor((fontPx * cols * SS * maxWidthFrac) / w),
      ),
    );
  }
  ctx.clearRect(0, 0, cols * SS, rows * SS);
  ctx.font = font(fontPx);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.fillText(text, (cols * SS) / 2, Math.round(rows * centerY) * SS);

  const data = ctx.getImageData(0, 0, cols * SS, rows * SS).data;
  const mask = new Float32Array(cols * rows);
  const full = SS * SS;
  let top = rows;
  let bottom = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        const rowBase = (y * SS + sy) * cols * SS;
        for (let sx = 0; sx < SS; sx++) {
          if (data[(rowBase + x * SS + sx) * 4 + 3] > 110) cover++;
        }
      }
      if (cover / full > 0.42) {
        mask[y * cols + x] = 1;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (top > bottom) return { ...empty, fontPx: fontPx / SS };
  return { mask, fontPx: fontPx / SS, top, bottom };
}

/** Separable box blur of a cell mask — used for soft halos around glyphs. */
export function blurMask(
  src: Float32Array,
  cols: number,
  rows: number,
  radius: number,
): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const norm = 1 / (radius * 2 + 1);
  for (let y = 0; y < rows; y++) {
    const base = y * cols;
    let acc = 0;
    for (let x = -radius; x <= radius; x++) {
      acc += src[base + Math.min(cols - 1, Math.max(0, x))];
    }
    for (let x = 0; x < cols; x++) {
      tmp[base + x] = acc * norm;
      const add = Math.min(cols - 1, x + radius + 1);
      const sub = Math.max(0, x - radius);
      acc += src[base + add] - src[base + sub];
    }
  }
  for (let x = 0; x < cols; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) {
      acc += tmp[Math.min(rows - 1, Math.max(0, y)) * cols + x];
    }
    for (let y = 0; y < rows; y++) {
      out[y * cols + x] = acc * norm;
      const add = Math.min(rows - 1, y + radius + 1) * cols + x;
      const sub = Math.max(0, y - radius) * cols + x;
      acc += tmp[add] - tmp[sub];
    }
  }
  return out;
}

/** Deterministic 2D hash noise in [0, 1) — static texture, no allocation. */
export function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

/** Resolves once the hero fonts (CamelCool + Silkscreen) are usable. */
export function whenHeroFontsReady(cb: () => void): () => void {
  let cancelled = false;
  if (typeof document !== "undefined" && document.fonts?.load) {
    Promise.all([
      document.fonts.load('400 64px "CamelCool"'),
      document.fonts.load('700 64px "Silkscreen"'),
      document.fonts.load('400 16px "Silkscreen"'),
    ])
      .then(() => {
        if (!cancelled) cb();
      })
      .catch(() => undefined);
  }
  return () => {
    cancelled = true;
  };
}
