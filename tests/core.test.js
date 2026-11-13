import test from 'node:test';
import assert from 'node:assert/strict';
import { fft, synthesize, spectrum, analyze, parseSamples, wav, examples } from '../core.js';
const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

function dft(real, imaginary) {
  const n = real.length,
    re = [],
    im = [];
  for (let k = 0; k < n; k++) {
    let r = 0,
      s = 0;
    for (let j = 0; j < n; j++) {
      const angle = (-2 * Math.PI * k * j) / n;
      r += real[j] * Math.cos(angle) - imaginary[j] * Math.sin(angle);
      s += real[j] * Math.sin(angle) + imaginary[j] * Math.cos(angle);
    }
    re.push(r);
    im.push(s);
  }
  return { real: re, imaginary: im };
}

test('FFT agrees with an independent direct complex DFT', () => {
  for (const n of [2, 4, 8, 16, 32, 64]) {
    const real = Array.from({ length: n }, (_, i) => Math.sin(i * 1.17) + i / n),
      imaginary = real.map((_, i) => Math.cos(i * 0.37));
    const actual = fft(real, imaginary),
      expected = dft(real, imaginary);
    for (let i = 0; i < n; i++) {
      near(actual.real[i], expected.real[i]);
      near(actual.imaginary[i], expected.imaginary[i]);
    }
  }
});
test('inverse FFT round-trips and Parseval energy holds', () => {
  for (const n of [32, 128, 1024, 4096]) {
    const signal = Array.from(
      { length: n },
      (_, i) => Math.sin(i * 0.123) + 0.2 * Math.cos(i * 0.37),
    );
    const transformed = fft(signal),
      restored = fft(transformed.real, transformed.imaginary, true);
    for (let i = 0; i < n; i++) {
      near(restored.real[i], signal[i]);
      near(restored.imaginary[i], 0);
    }
    near(
      signal.reduce((s, x) => s + x * x, 0),
      transformed.real.reduce((s, r, i) => s + r * r + transformed.imaginary[i] ** 2, 0) / n,
      1e-7,
    );
  }
});
test('bin-centered tones preserve amplitude under rectangular and periodic Hann windows', () => {
  const signal = synthesize({
    sampleRate: 8192,
    count: 1024,
    tones: [{ frequency: 1000, amplitude: 0.8, phase: 31 }],
  });
  for (const window of ['rectangular', 'hann']) {
    const result = spectrum(signal, 8192, window);
    near(result.bins[125].amplitude, 0.8);
    assert.equal(result.peaks[0].frequency, 1000);
  }
});
test('DC and Nyquist bins are not doubled', () => {
  for (const window of ['rectangular', 'hann']) {
    near(spectrum(Array(64).fill(0.4), 8192, window).bins[0].amplitude, 0.4);
    near(
      spectrum(
        Array.from({ length: 64 }, (_, i) => (i % 2 ? -0.6 : 0.6)),
        8192,
        window,
      ).bins[32].amplitude,
      0.6,
    );
  }
});
test('Hann reduces distant leakage for an off-bin tone', () => {
  const signal = synthesize({ tones: [{ frequency: 1003, amplitude: 0.8, phase: 0 }] });
  const rectangle = spectrum(signal, 8192, 'rectangular'),
    hann = spectrum(signal, 8192, 'hann');
  const distant = (result) =>
    result.bins
      .filter((bin) => Math.abs(bin.index - 125) > 5)
      .reduce((sum, bin) => sum + bin.amplitude ** 2, 0);
  assert.ok(distant(hann) < distant(rectangle) / 100);
});
test('noise is repeatable and analysis does not mutate source samples', () => {
  const a = synthesize(examples.noisy),
    b = synthesize(examples.noisy);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, synthesize({ ...examples.noisy, seed: 99 }));
  const copy = [...a];
  const result = analyze(a, 8192);
  assert.deepEqual(a, copy);
  assert.equal(result.count, 2048);
  near(result.binWidth, 4);
});
test('silence produces finite floored dB values and no peaks', () => {
  const result = analyze(Array(32).fill(0), 8192);
  assert.equal(result.rms, 0);
  assert.equal(result.wavScale, 1);
  assert.deepEqual(result.hann.peaks, []);
  assert.ok(result.hann.bins.every((bin) => bin.db === -180));
});
test('sample parsing is strict, bounded, and round-trippable', () => {
  const samples = Array.from({ length: 32 }, (_, i) => i / 32);
  assert.deepEqual(parseSamples(samples.join('\n')), samples);
  assert.deepEqual(parseSamples(samples.join(',')), samples);
  for (const text of [
    '',
    'sample\n' + samples.join('\n'),
    'NaN '.repeat(32),
    '7 '.repeat(32),
    '1 '.repeat(33),
    '1 '.repeat(8192),
  ])
    assert.throws(() => parseSamples(text));
});
test('configuration validation rejects aliasing inputs and malformed FFT sizes', () => {
  assert.throws(() => fft([1, 2, 3]));
  assert.throws(() => fft([1, Infinity]));
  assert.throws(() => fft([1, 2], [1, 2, 3, 4]));
  assert.throws(() => synthesize({ tones: [{ frequency: 5000, amplitude: 1 }] }));
  assert.throws(() => synthesize({ count: 33 }));
  assert.throws(() => synthesize({ seed: -1 }));
  assert.throws(() => spectrum(Array(32).fill(0), 8192, 'unknown'));
});
test('WAV header, signed endpoints and normalization are consistent', () => {
  const samples = Array.from({ length: 32 }, (_, i) => (i % 2 ? -2 : 2)),
    { buffer, scale } = wav(samples, 8192),
    view = new DataView(buffer);
  near(scale, 0.5);
  assert.equal(buffer.byteLength, 108);
  assert.equal(new TextDecoder().decode(new Uint8Array(buffer, 0, 4)), 'RIFF');
  assert.equal(view.getUint32(24, true), 8192);
  assert.equal(view.getUint32(40, true), 64);
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
});
