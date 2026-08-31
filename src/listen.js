// Live audio → 12 pitch-class levels.
//
// Lifted verbatim from jetk/sefirograph, where it was written and tuned against
// real music. Unchanged on purpose: if it needs fixing, fix it there and copy it
// back, rather than letting two versions drift. It takes an AudioContext and a
// stream as arguments and never touches the document, so it keeps this repo's
// rule that only app.js does.
//
// Deliberately NOT note transcription. Polyphonic transcription is a research
// problem; a chromagram is ~60 lines and is all the wheel needs, because the
// diagrams only ever ask which pitch classes are sounding and how strongly.
//
// What you give up: octaves. That is why Combined stays on MIDI — its register,
// bass and polyphony features have nothing to read without them.

export const CHROMA_CONFIG = {
  // Resolution is driven entirely by the bass. Semitone spacing is 3.9 Hz at C2,
  // 7.8 Hz at C3, 15.6 Hz at C4 — so the top of the range tolerates a much
  // shorter window than the bottom, and a short window is a short delay.
  // At 48 kHz: 4096 → 85 ms / 11.7 Hz bins, 16384 → 341 ms / 2.9 Hz bins.
  splitMidi: 60, // C4. Above this the fast analyser resolves semitones fine.
  highFft: 4096,
  lowFft: 16384,
  minMidi: 36, // C2
  maxMidi: 96, // C7

  floorDb: -85,
  gate: 0.12, // fraction of the peak below which a pitch class reads as silent

  // Attack is instant; only the fall is smoothed. Fast attack is what makes the
  // glow feel locked to the beat, and a slow release just reads as decay.
  releaseTau: 0.18,
  // A spectral-flux spike means a new event, so drop the release and snap.
  fluxSnap: 0.55,
};

export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Half a semitone either side of the note's centre frequency.
export function binRange(midi, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  const f = midiToFreq(midi);
  const lo = Math.floor((f * Math.pow(2, -0.5 / 12)) / binHz);
  const hi = Math.ceil((f * Math.pow(2, 0.5 / 12)) / binHz);
  return [Math.max(0, lo), Math.min(fftSize / 2 - 1, hi)];
}

// How much a bin counts towards a note: full at its centre, zero half a semitone
// away. Needed because bins are coarse near the split — at 11.7 Hz a flat
// ±50 cent window rounds out to *wider* than a semitone around E4, so E and Eb
// would claim the same bin and tie. Distance in cents breaks that correctly.
export function binWeight(binFreq, noteFreq) {
  if (binFreq <= 0) return 0;
  const cents = Math.abs(1200 * Math.log2(binFreq / noteFreq));
  return cents >= 50 ? 0 : 1 - cents / 50;
}

// A real partial is a local maximum. The skirts either side of it are monotonic
// slopes, so requiring a local max throws away spectral leakage — without which
// a loud E puts ~37% of its level into Eb's bins and lights the wrong node.
function isLocalPeak(data, b) {
  if (b <= 0 || b >= data.length - 1) return false;
  return data[b] >= data[b - 1] && data[b] >= data[b + 1];
}

// Peak-per-note rather than sum-per-note: summing lets the wider bin range of a
// high note out-shout a narrow one lower down.
export function foldToChroma(highDb, lowDb, sampleRate, cfg = CHROMA_CONFIG) {
  const chroma = new Array(12).fill(0);
  for (let m = cfg.minMidi; m <= cfg.maxMidi; m++) {
    const data = m >= cfg.splitMidi ? highDb : lowDb;
    const fftSize = data.length * 2;
    const binHz = sampleRate / fftSize;
    const f = midiToFreq(m);
    const [lo, hi] = binRange(m, sampleRate, fftSize);
    let peak = 0;
    for (let b = lo; b <= hi && b < data.length; b++) {
      if (data[b] <= cfg.floorDb || !isLocalPeak(data, b)) continue;
      const mag = Math.pow(10, data[b] / 20) * binWeight(b * binHz, f);
      if (mag > peak) peak = mag;
    }
    chroma[m % 12] += peak;
  }
  return chroma;
}

// Relative to the loudest class, so the wheel reads the same quiet or loud.
export function normalize(chroma, gate) {
  let max = 0;
  for (const v of chroma) if (v > max) max = v;
  if (max <= 0) return new Array(12).fill(0);
  return chroma.map((v) => {
    const n = v / max;
    return n < gate ? 0 : (n - gate) / (1 - gate);
  });
}

// Exponential release approaches zero without ever reaching it, so anything that
// ever spiked would stay fractionally lit forever and the readout would list all
// twelve classes after the first transient. Below SILENT it is silence — set at
// 2%, which is both invisible and low enough that a click clears in under a
// second rather than lingering as a named-but-unlit pitch class.
const SILENT = 0.02;

export function smooth(prev, target, dt, cfg = CHROMA_CONFIG, snap = false) {
  const k = 1 - Math.exp(-dt / cfg.releaseTau);
  return target.map((t, i) => {
    if (snap || t >= prev[i]) return t;
    const v = prev[i] + (t - prev[i]) * k;
    return v < SILENT ? 0 : v;
  });
}

// Sum of positive frame-to-frame rises. The /6 makes "6 dB of average rise"
// read as 1.0 — a calibration knob, not a derived constant.
export function spectralFlux(db, prevDb, floorDb) {
  if (!prevDb) return 0;
  let sum = 0;
  for (let i = 0; i < db.length; i++) {
    const a = Math.max(db[i], floorDb);
    const b = Math.max(prevDb[i], floorDb);
    if (a > b) sum += a - b;
  }
  return db.length ? sum / db.length / 6 : 0;
}

export function createListener(ctx, stream, cfg = CHROMA_CONFIG) {
  const source = ctx.createMediaStreamSource(stream);
  const makeAnalyser = (fftSize) => {
    const a = ctx.createAnalyser();
    a.fftSize = fftSize;
    // The 0.8 default is a symmetric EMA across frames: it delays onsets and
    // blunts them. We smooth ourselves, asymmetrically, further down.
    a.smoothingTimeConstant = 0;
    source.connect(a);
    return a;
  };
  const high = makeAnalyser(cfg.highFft);
  const low = makeAnalyser(cfg.lowFft);
  // Never connected to ctx.destination: the captured tab is already audible, and
  // routing it back would double it.

  const highDb = new Float32Array(high.frequencyBinCount);
  const lowDb = new Float32Array(low.frequencyBinCount);
  let prevHigh = null;
  let levels = new Array(12).fill(0);
  let lastAt = null;

  return {
    read(now) {
      high.getFloatFrequencyData(highDb);
      low.getFloatFrequencyData(lowDb);
      const dt = lastAt == null ? 0.016 : Math.max(0.001, now - lastAt);
      lastAt = now;

      const flux = spectralFlux(highDb, prevHigh, cfg.floorDb);
      prevHigh = Float32Array.from(highDb);

      const target = normalize(foldToChroma(highDb, lowDb, ctx.sampleRate, cfg), cfg.gate);
      levels = smooth(levels, target, dt, cfg, flux > cfg.fluxSnap);
      return levels;
    },
    dispose() {
      try { source.disconnect(); } catch { /* context may already be closed */ }
    },
  };
}
