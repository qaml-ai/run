/**
 * Audio features for the turn models, in plain TypeScript (no native code): Whisper's log-mel spectrogram, as Smart Turn
 * takes it (Hugging Face's WhisperFeatureExtractor(chunk_length=8) with do_normalize, which pipecat's inference uses),
 * and the resampling the voice pipeline needs to feed 16 kHz models.
 */

export const WHISPER = Object.freeze({ rate: 16_000, nFft: 400, hop: 160, mels: 80, frames: 800, samples: 8 * 16_000 });

const BINS = WHISPER.nFft / 2 + 1;

/** Slaney's mel scale (librosa's default, Whisper's). */
const LOG_STEP = 27 / Math.log(6.4);
const hzToMel = (hz: number) => hz < 1_000 ? 3 * hz / 200 : 15 + Math.log(hz / 1_000) * LOG_STEP;
const melToHz = (mel: number) => mel < 15 ? 200 * mel / 3 : 1_000 * Math.exp((mel - 15) / LOG_STEP);

/** Each mel filter as its first bin and weights (slaney-normalized triangles, 0 to 8 kHz): mostly zeros, kept sparse. */
const FILTERS: { from: number; weights: Float64Array }[] = (() => {
  const fft = Array.from({ length: BINS }, (_, k) => k * (WHISPER.rate / 2) / (BINS - 1));
  const top = hzToMel(WHISPER.rate / 2);
  const edges = Array.from({ length: WHISPER.mels + 2 }, (_, i) => melToHz(top * i / (WHISPER.mels + 1)));
  return Array.from({ length: WHISPER.mels }, (_, m) => {
    const weights = new Float64Array(BINS);
    let from = BINS, to = 0;
    const norm = 2 / (edges[m + 2] - edges[m]);
    for (let k = 0; k < BINS; k++) {
      const down = (fft[k] - edges[m]) / (edges[m + 1] - edges[m]);
      const up = (edges[m + 2] - fft[k]) / (edges[m + 2] - edges[m + 1]);
      const w = Math.max(0, Math.min(down, up)) * norm;
      if (w > 0) { weights[k] = w; from = Math.min(from, k); to = k; }
    }
    return { from, weights: weights.slice(from, to + 1) };
  });
})();

/** The periodic Hann window of nFft samples. */
const WINDOW = Float64Array.from({ length: WHISPER.nFft }, (_, n) => 0.5 - 0.5 * Math.cos(2 * Math.PI * n / WHISPER.nFft));

/**
 * A complex FFT of 200 points (mixed radix, in place, decimation in time), which the real 400-point FFT is made of.
 * Stages from the innermost radix out; the input is put in the order the stages expect once.
 */
const HALF = WHISPER.nFft / 2;
const RADICES = [2, 2, 2, 5, 5];
const ORDER: Int32Array = (() => {
  const out: number[] = [];
  const walk = (n: number, depth: number, stride: number, offset: number) => {
    if (n === 1) { out.push(offset); return; }
    const p = RADICES[depth];
    for (let r = 0; r < p; r++) walk(n / p, depth + 1, stride * p, offset + r * stride);
  };
  walk(HALF, 0, 1, 0);
  return Int32Array.from(out);
})();
type Stage = { p: number; m: number; cos: Float64Array; sin: Float64Array };
const STAGES: Stage[] = (() => {
  const stages: Stage[] = [];
  let m = 1;
  for (let depth = RADICES.length - 1; depth >= 0; depth--) {
    const p = RADICES[depth], l = p * m;
    const cos = new Float64Array(p * m), sin = new Float64Array(p * m);
    for (let r = 0; r < p; r++) for (let k = 0; k < m; k++) { cos[r * m + k] = Math.cos(-2 * Math.PI * r * k / l); sin[r * m + k] = Math.sin(-2 * Math.PI * r * k / l); }
    stages.push({ p, m, cos, sin });
    m = l;
  }
  return stages;
})();
const TW_COS = Float64Array.from({ length: BINS }, (_, k) => Math.cos(-2 * Math.PI * k / WHISPER.nFft));
const TW_SIN = Float64Array.from({ length: BINS }, (_, k) => Math.sin(-2 * Math.PI * k / WHISPER.nFft));

const C1 = Math.cos(2 * Math.PI / 5), C2 = Math.cos(4 * Math.PI / 5), S1 = Math.sin(2 * Math.PI / 5), S2 = Math.sin(4 * Math.PI / 5);

function fft200(re: Float64Array, im: Float64Array) {
  for (const { p, m, cos, sin } of STAGES) {
    const l = p * m;
    for (let block = 0; block < HALF; block += l) {
      for (let k = 0; k < m; k++) {
        const i0 = block + k;
        if (p === 2) {
          const i1 = i0 + m, c = cos[m + k], s = sin[m + k];
          const br = re[i1] * c - im[i1] * s, bi = re[i1] * s + im[i1] * c;
          const ar = re[i0], ai = im[i0];
          re[i0] = ar + br; im[i0] = ai + bi;
          re[i1] = ar - br; im[i1] = ai - bi;
          continue;
        }
        // Radix 5: the twiddled inputs, then the 5-point DFT in its symmetric form.
        const i1 = i0 + m, i2 = i1 + m, i3 = i2 + m, i4 = i3 + m;
        const t0r = re[i0], t0i = im[i0];
        let c = cos[m + k], s = sin[m + k];
        const t1r = re[i1] * c - im[i1] * s, t1i = re[i1] * s + im[i1] * c;
        c = cos[2 * m + k]; s = sin[2 * m + k];
        const t2r = re[i2] * c - im[i2] * s, t2i = re[i2] * s + im[i2] * c;
        c = cos[3 * m + k]; s = sin[3 * m + k];
        const t3r = re[i3] * c - im[i3] * s, t3i = re[i3] * s + im[i3] * c;
        c = cos[4 * m + k]; s = sin[4 * m + k];
        const t4r = re[i4] * c - im[i4] * s, t4i = re[i4] * s + im[i4] * c;
        const a1r = t1r + t4r, a1i = t1i + t4i, b1r = t1r - t4r, b1i = t1i - t4i;
        const a2r = t2r + t3r, a2i = t2i + t3i, b2r = t2r - t3r, b2i = t2i - t3i;
        const m1r = t0r + C1 * a1r + C2 * a2r, m1i = t0i + C1 * a1i + C2 * a2i;
        const m2r = t0r + C2 * a1r + C1 * a2r, m2i = t0i + C2 * a1i + C1 * a2i;
        // -i * (S1 b1 + S2 b2) and -i * (S2 b1 - S1 b2).
        const n1r = S1 * b1i + S2 * b2i, n1i = -(S1 * b1r + S2 * b2r);
        const n2r = S2 * b1i - S1 * b2i, n2i = -(S2 * b1r - S1 * b2r);
        re[i0] = t0r + a1r + a2r; im[i0] = t0i + a1i + a2i;
        re[i1] = m1r + n1r; im[i1] = m1i + n1i;
        re[i4] = m1r - n1r; im[i4] = m1i - n1i;
        re[i2] = m2r + n2r; im[i2] = m2i + n2i;
        re[i3] = m2r - n2r; im[i3] = m2i - n2i;
      }
    }
  }
}

/** |rfft(frame)|^2 for a 400-sample real frame, into power (201 bins). */
function powerSpectrum(frame: Float64Array, power: Float64Array, scratch: Scratch) {
  const { re, im } = scratch;
  for (let n = 0; n < HALF; n++) { const from = ORDER[n]; re[n] = frame[2 * from]; im[n] = frame[2 * from + 1]; }
  fft200(re, im);
  for (let k = 0; k <= HALF; k++) {
    const a = k % HALF, b = (HALF - k) % HALF;
    // Even and odd samples' spectra, from the packed transform.
    const er = (re[a] + re[b]) / 2, ei = (im[a] - im[b]) / 2;
    const or = (im[a] + im[b]) / 2, oi = -(re[a] - re[b]) / 2;
    const xr = er + or * TW_COS[k] - oi * TW_SIN[k];
    const xi = ei + or * TW_SIN[k] + oi * TW_COS[k];
    power[k] = xr * xr + xi * xi;
  }
}
type Scratch = { re: Float64Array; im: Float64Array };

/** The window's own power spectrum: a frame of constant samples c has c^2 times this. */
const WINDOW_POWER = (() => {
  const power = new Float64Array(BINS);
  powerSpectrum(WINDOW, power, { re: new Float64Array(HALF), im: new Float64Array(HALF) });
  return power;
})();

/**
 * Smart Turn's input: the last 8 s of 16 kHz mono audio (zeros before it when shorter), normalized to zero mean and unit
 * variance, as an 80 x 800 log-mel spectrogram (row-major, mel by frame). Frames wholly in leading zeros are a constant
 * after normalizing, and take the window's spectrum scaled, with no FFT, so a short turn costs little.
 */
export function logMel(audio: Float32Array): Float32Array {
  const { samples, nFft, hop, frames, mels } = WHISPER;
  const pad = nFft / 2;
  const x = new Float64Array(samples);
  const given = audio.length > samples ? audio.subarray(audio.length - samples) : audio;
  x.set(given, samples - given.length);
  let sum = 0;
  for (let i = 0; i < samples; i++) sum += x[i];
  const mean = sum / samples;
  let squares = 0;
  for (let i = 0; i < samples; i++) { const d = x[i] - mean; squares += d * d; }
  const scale = 1 / Math.sqrt(squares / samples + 1e-7);
  // The audio starts here; frames that end before it (with the reflection) are all the constant.
  const firstAudio = samples - given.length;
  const constant = -mean * scale;
  const padded = new Float64Array(samples + 2 * pad);
  for (let i = 0; i < samples; i++) padded[pad + i] = (x[i] - mean) * scale;
  for (let i = 0; i < pad; i++) { padded[i] = padded[2 * pad - i]; padded[pad + samples + i] = padded[pad + samples - 2 - i]; }
  const out = new Float32Array(mels * frames);
  const frame = new Float64Array(nFft), power = new Float64Array(BINS);
  const scratch: Scratch = { re: new Float64Array(HALF), im: new Float64Array(HALF) };
  let max = -Infinity;
  for (let t = 0; t < frames; t++) {
    const start = t * hop;
    // Padded [start, start + nFft) covers x from start - pad to start + pad - 1, reflected at 0: all before the audio?
    if (start + nFft - pad <= firstAudio && pad < firstAudio) {
      for (let k = 0; k < BINS; k++) power[k] = constant * constant * WINDOW_POWER[k];
    } else {
      for (let n = 0; n < nFft; n++) frame[n] = padded[start + n] * WINDOW[n];
      powerSpectrum(frame, power, scratch);
    }
    for (let m = 0; m < mels; m++) {
      const { from, weights } = FILTERS[m];
      let energy = 0;
      for (let j = 0; j < weights.length; j++) energy += weights[j] * power[from + j];
      const value = Math.log10(Math.max(energy, 1e-10));
      out[m * frames + t] = value;
      if (value > max) max = value;
    }
  }
  const floor = max - 8;
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i], floor) + 4) / 4;
  return out;
}

/**
 * 16-bit PCM as floats in [-1, 1).
 */
export function floats(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32_768;
  return out;
}

/** Half-band low-pass taps for 2:3 resampling (24 kHz to 16 kHz): a windowed sinc at 7.2 kHz, of 48 kHz (the 2x upsampled rate). */
const RESAMPLE_TAPS = (() => {
  const taps = 48, cutoff = 7_200 / 48_000;
  const out = new Float64Array(taps);
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const t = n - (taps - 1) / 2;
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * n / (taps - 1));
    out[n] = sinc * w;
    sum += out[n];
  }
  for (let n = 0; n < taps; n++) out[n] *= 2 / sum;
  return out;
})();

/**
 * A stream of 24 kHz mono PCM as 16 kHz (2:3, low-passed so nothing above 8 kHz folds back), keeping the filter's history
 * between chunks, so 20 ms frames in give 20 ms frames out (480 samples to 320).
 */
export class Resampler24To16 {
  /** The last input samples the filter still reaches (HISTORY), then each chunk. */
  private buffer = new Float64Array(HISTORY);
  /** Input samples taken, and output samples made, since the start. */
  private taken = 0;
  private made = 0;

  push(pcm: Int16Array): Int16Array {
    const buffer = new Float64Array(HISTORY + pcm.length);
    buffer.set(this.buffer.subarray(this.buffer.length - HISTORY));
    buffer.set(pcm, HISTORY);
    // Input sample i (global) is at buffer[i - (taken - HISTORY)]; upsampled, it is at 2i. Output m is at 3m.
    const base = this.taken - HISTORY;
    const total = this.taken + pcm.length;
    const out: number[] = [];
    // Output m needs input up to floor(3m / 2).
    for (let m = this.made; Math.floor(3 * m / 2) < total; m++) {
      const u = 3 * m;
      let acc = 0;
      for (let i = Math.floor(u / 2); 2 * i > u - RESAMPLE_TAPS.length && i >= base; i--) acc += RESAMPLE_TAPS[u - 2 * i] * buffer[i - base];
      out.push(Math.max(-32_768, Math.min(32_767, Math.round(acc))));
      this.made = m + 1;
    }
    this.taken = total;
    this.buffer = buffer;
    return Int16Array.from(out);
  }
}
const HISTORY = RESAMPLE_TAPS.length / 2;
