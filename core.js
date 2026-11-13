function bounded(value, low, high, name, integer = false) {
  if (
    !Number.isFinite(value) ||
    value < low ||
    value > high ||
    (integer && !Number.isInteger(value))
  ) {
    throw Error(`${name} must be ${integer ? 'an integer ' : ''}from ${low} to ${high}.`);
  }
  return value;
}

function series(values, minimum = 2, limit = 1e12) {
  if (
    (!Array.isArray(values) && !(values instanceof Float64Array)) ||
    values.length < minimum ||
    values.length > 4096 ||
    values.length & (values.length - 1)
  ) {
    throw Error(`Use a power-of-two sample count from ${minimum} to 4096.`);
  }
  if (Array.from(values).some((value) => !Number.isFinite(value) || Math.abs(value) > limit))
    throw Error(`Samples must be finite and no greater than ${limit} in absolute value.`);
}

/** Iterative radix-2 Cooley–Tukey FFT; inverse includes 1/N scaling. */
export function fft(real, imaginary = null, inverse = false) {
  series(real);
  if (imaginary !== null) {
    series(imaginary);
    if (imaginary.length !== real.length)
      throw Error('Real and imaginary arrays must have equal lengths.');
  }
  const re = Float64Array.from(real),
    im = imaginary ? Float64Array.from(imaginary) : new Float64Array(real.length),
    n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / size;
    const stepRe = Math.cos(angle),
      stepIm = Math.sin(angle);
    for (let base = 0; base < n; base += size) {
      let wr = 1,
        wi = 0;
      for (let j = 0; j < size / 2; j++) {
        const even = base + j,
          odd = even + size / 2;
        const tr = wr * re[odd] - wi * im[odd],
          ti = wr * im[odd] + wi * re[odd];
        re[odd] = re[even] - tr;
        im[odd] = im[even] - ti;
        re[even] += tr;
        im[even] += ti;
        const nextRe = wr * stepRe - wi * stepIm;
        wi = wr * stepIm + wi * stepRe;
        wr = nextRe;
      }
    }
  }
  if (inverse)
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  return { real: Array.from(re), imaginary: Array.from(im) };
}

export function synthesize({
  sampleRate = 8192,
  count = 1024,
  tones = [{ frequency: 1000, amplitude: 0.8, phase: 0 }],
  noise = 0,
  offset = 0,
  seed = 1,
} = {}) {
  bounded(sampleRate, 8000, 96000, 'Sample rate', true);
  bounded(count, 32, 4096, 'Sample count', true);
  if (count & (count - 1)) throw Error('Sample count must be a power of two.');
  if (!Array.isArray(tones) || tones.length > 4) throw Error('Use at most four tones.');
  for (const tone of tones) {
    if (!tone || typeof tone !== 'object') throw Error('Invalid tone.');
    bounded(tone.frequency, 0, sampleRate / 2, 'Tone frequency');
    bounded(tone.amplitude, 0, 1, 'Tone amplitude');
    bounded(tone.phase ?? 0, -360, 360, 'Tone phase');
  }
  bounded(noise, 0, 1, 'Noise amplitude');
  bounded(offset, -1, 1, 'DC offset');
  bounded(seed, 0, 0xffffffff, 'Seed', true);
  let state = seed;
  const samples = Array.from({ length: count }, (_, i) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (
      offset +
      noise * ((2 * state) / 4294967296 - 1) +
      tones.reduce(
        (sum, tone) =>
          sum +
          tone.amplitude *
            Math.sin(
              (2 * Math.PI * tone.frequency * i) / sampleRate + ((tone.phase ?? 0) * Math.PI) / 180,
            ),
        0,
      )
    );
  });
  // Four full-amplitude tones plus noise and offset can reach six.
  return samples;
}

export function parseSamples(text) {
  if (typeof text !== 'string' || text.length > 100000)
    throw Error('Sample text is limited to 100,000 characters.');
  const tokens = text
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (tokens.some((token) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)))
    throw Error(
      'Use numeric amplitudes separated by commas or whitespace, without a header or time column.',
    );
  const samples = tokens.map(Number);
  series(samples, 32, 6);
  return samples;
}

export function spectrum(samples, sampleRate, window = 'hann') {
  series(samples, 32, 6);
  bounded(sampleRate, 8000, 96000, 'Sample rate', true);
  if (!['hann', 'rectangular'].includes(window)) throw Error('Unknown window.');
  const n = samples.length,
    weights = samples.map((_, i) =>
      window === 'hann' ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n) : 1,
    );
  const coherentGain = weights.reduce((a, b) => a + b, 0) / n;
  const transformed = fft(samples.map((value, i) => value * weights[i]));
  const bins = Array.from({ length: n / 2 + 1 }, (_, k) => {
    const magnitude = Math.hypot(transformed.real[k], transformed.imaginary[k]);
    const amplitude = (magnitude / (n * coherentGain)) * (k === 0 || k === n / 2 ? 1 : 2);
    return {
      index: k,
      frequency: (k * sampleRate) / n,
      amplitude,
      db: 20 * Math.log10(Math.max(amplitude, 1e-9)),
    };
  });
  const peaks = bins
    .filter(
      (bin, i) =>
        bin.amplitude > 1e-10 &&
        (i === 0 || bin.amplitude >= bins[i - 1].amplitude) &&
        (i === bins.length - 1 || bin.amplitude > bins[i + 1].amplitude),
    )
    .sort((a, b) => b.amplitude - a.amplitude || a.index - b.index)
    .slice(0, 8);
  return { window, coherentGain, bins, peaks };
}

export function analyze(samples, sampleRate) {
  series(samples, 32, 6);
  bounded(sampleRate, 8000, 96000, 'Sample rate', true);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  const peak = Math.max(...samples.map(Math.abs));
  return {
    format: 'signal-study-v1',
    sampleRate,
    count: samples.length,
    duration: samples.length / sampleRate,
    binWidth: sampleRate / samples.length,
    nyquist: sampleRate / 2,
    mean,
    rms,
    peak,
    wavScale: peak > 1 ? 1 / peak : 1,
    samples: Array.from(samples),
    rectangular: spectrum(samples, sampleRate, 'rectangular'),
    hann: spectrum(samples, sampleRate, 'hann'),
  };
}

/** Mono PCM16 WAV, normalized only when the input peak exceeds one. */
export function wav(samples, sampleRate) {
  series(samples, 32, 6);
  bounded(sampleRate, 8000, 96000, 'Sample rate', true);
  const peak = Math.max(...samples.map(Math.abs)),
    scale = peak > 1 ? 1 / peak : 1;
  const buffer = new ArrayBuffer(44 + samples.length * 2),
    view = new DataView(buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((value, i) => {
    const x = Math.max(-1, Math.min(1, value * scale));
    view.setInt16(44 + i * 2, Math.round(x * (x < 0 ? 32768 : 32767)), true);
  });
  return { buffer, scale };
}

export const examples = {
  clean: {
    sampleRate: 8192,
    count: 1024,
    tones: [
      { frequency: 1000, amplitude: 0.8, phase: 0 },
      { frequency: 1800, amplitude: 0.3, phase: 0 },
    ],
    noise: 0,
    offset: 0,
    seed: 1,
  },
  leakage: {
    sampleRate: 8192,
    count: 1024,
    tones: [
      { frequency: 1003, amplitude: 0.8, phase: 0 },
      { frequency: 1080, amplitude: 0.08, phase: 0 },
    ],
    noise: 0,
    offset: 0,
    seed: 1,
  },
  noisy: {
    sampleRate: 8192,
    count: 2048,
    tones: [
      { frequency: 400, amplitude: 0.5, phase: 0 },
      { frequency: 1200, amplitude: 0.2, phase: 0 },
    ],
    noise: 0.2,
    offset: 0.15,
    seed: 42,
  },
};
