import { analyze, synthesize, parseSamples, wav, examples } from './core.js';
const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
let report = null,
  revision = 0,
  audioContext = null,
  playback = null,
  playbackGain = null,
  audioTicket = 0;
const numeric = (id) => Number($(id).value);
function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').className = error ? 'error' : '';
}
function stopAudio() {
  audioTicket++;
  if (playback) {
    playback.onended = null;
    playback.stop();
    playback.disconnect();
    playback = null;
  }
  playbackGain?.disconnect();
  playbackGain = null;
  $('listen').textContent = 'Listen once ▷';
}
function invalidate() {
  revision++;
  stopAudio();
  report = null;
  for (const id of ['listen', 'save-wav', 'save-samples', 'save-report', 'bin'])
    $(id).disabled = true;
  for (const id of ['wave-plot', 'spectrum-plot', 'stats', 'peaks']) $(id).replaceChildren();
  for (const id of ['wave-caption', 'spectrum-caption', 'bin-readout', 'wav-note'])
    $(id).textContent = '';
  notice('Inputs changed. Generate a waveform or import samples to update the analysis.');
}
function config() {
  return {
    sampleRate: numeric('sample-rate'),
    count: numeric('count'),
    tones: [
      { frequency: numeric('frequency-a'), amplitude: numeric('amplitude-a'), phase: 0 },
      { frequency: numeric('frequency-b'), amplitude: numeric('amplitude-b'), phase: 0 },
    ],
    noise: numeric('noise'),
    offset: numeric('offset'),
    seed: numeric('seed'),
  };
}
function setReport(samples, source) {
  report = analyze(samples, numeric('sample-rate'));
  $('sample-source').textContent = source;
  for (const id of ['listen', 'save-wav', 'save-samples', 'save-report', 'bin'])
    $(id).disabled = false;
  $('bin').max = report.count / 2;
  $('bin').value = Math.min(numeric('bin'), report.count / 2);
  render();
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
    for (const plot of document.querySelectorAll('.plot svg'))
      plot.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 400 });
  notice(`Analyzed ${report.count} samples. Bin spacing: ${report.binWidth.toFixed(3)} Hz.`);
}
function generate() {
  invalidate();
  try {
    const settings = config();
    setReport(synthesize(settings), 'SYNTHESIZED');
  } catch (error) {
    notice(error.message, true);
  }
}
function graph(xMax, yMin, yMax, lines, label) {
  const w = Math.max(280, $('wave-plot').clientWidth),
    h = $('wave-plot').clientHeight || 260,
    l = 48,
    r = 18,
    t = 16,
    b = 32,
    plotW = w - l - r,
    plotH = h - t - b;
  const x = (value) => l + (value / xMax) * plotW,
    y = (value) => t + ((yMax - Math.max(yMin, Math.min(yMax, value))) / (yMax - yMin)) * plotH;
  let markup = `<svg viewBox="0 0 ${w} ${h}" role="img" data-xmax="${xMax}" data-ymin="${yMin}" data-ymax="${yMax}" aria-label="${esc(label)}">`;
  for (let i = 0; i <= 4; i++) {
    const yy = t + (i * plotH) / 4,
      value = yMax - (i * (yMax - yMin)) / 4;
    markup += `<line class="grid-line" x1="${l}" y1="${yy}" x2="${w - r}" y2="${yy}"/><text class="axis-label" x="${l - 7}" y="${yy + 3}" text-anchor="end">${Number(value.toFixed(2))}</text>`;
    const xx = l + (i * plotW) / 4;
    markup += `<line class="grid-line" x1="${xx}" y1="${t}" x2="${xx}" y2="${h - b}"/><text class="axis-label" x="${xx}" y="${h - 10}" text-anchor="middle">${Number(((i * xMax) / 4).toFixed(2))}</text>`;
  }
  for (const line of lines)
    markup += `<polyline class="${line.className}" points="${line.points.map(([a, v]) => `${x(a).toFixed(2)},${y(v).toFixed(2)}`).join(' ')}"/>`;
  return markup + '</svg>';
}
function render() {
  if (!report) return;
  const n = Math.min(512, report.count),
    limit = Math.max(0.1, report.peak * 1.1),
    duration = ((n - 1) / report.sampleRate) * 1000;
  $('wave-plot').innerHTML = graph(
    duration,
    -limit,
    limit,
    [
      {
        className: 'wave-line',
        points: report.samples.slice(0, n).map((v, i) => [(i / report.sampleRate) * 1000, v]),
      },
    ],
    'Waveform: time in milliseconds and sample amplitude',
  );
  $('wave-caption').textContent =
    `First ${n} of ${report.count} samples · horizontal axis in milliseconds · record duration ${(report.duration * 1000).toFixed(2)} ms.`;
  $('stats').innerHTML = [
    ['RMS', report.rms.toFixed(4)],
    ['PEAK', report.peak.toFixed(4)],
    ['MEAN / DC', (Math.abs(report.mean) < 0.00005 ? 0 : report.mean).toFixed(4)],
    ['BIN WIDTH', report.binWidth.toFixed(2) + ' Hz'],
  ]
    .map(([label, value]) => `<div><strong>${value}</strong><span>${label}</span></div>`)
    .join('');
  const requested = numeric('range'),
    maxFrequency = requested ? Math.min(requested, report.nyquist) : report.nyquist,
    db = $('scale').value === 'db';
  const lines = ['rectangular', 'hann'].map((window) => ({
    className: window === 'hann' ? 'hann-line' : 'rect-line',
    points: report[window].bins
      .filter((bin) => bin.frequency <= maxFrequency)
      .map((bin) => [bin.frequency, db ? bin.db : bin.amplitude]),
  }));
  const top = db
    ? Math.max(
        0,
        Math.ceil(Math.max(...lines.flatMap((line) => line.points.map((p) => p[1]))) / 20) * 20,
      )
    : Math.max(0.1, ...lines.flatMap((line) => line.points.map((p) => p[1]))) * 1.1;
  $('spectrum-plot').innerHTML = graph(
    maxFrequency,
    db ? -100 : 0,
    top,
    lines,
    `One-sided amplitude spectra, frequency in hertz and ${db ? 'decibels relative to amplitude one' : 'linear amplitude'}`,
  );
  $('spectrum-caption').textContent = db
    ? 'Frequency / Hz · dB relative to amplitude 1 · display floor −100 dB (report floor −180 dB).'
    : 'Frequency / Hz · one-sided linear amplitude, corrected for coherent gain.';
  const window = $('peak-window').value;
  $('peaks').innerHTML =
    report[window].peaks
      .map(
        (bin) =>
          `<tr><td>${bin.index}</td><td>${bin.frequency.toFixed(3)}</td><td>${bin.amplitude.toFixed(6)}</td><td>${bin.db.toFixed(2)}</td></tr>`,
      )
      .join('') || '<tr><td colspan="4">No nonzero local maxima.</td></tr>';
  $('wav-note').textContent =
    `WAV export: mono PCM16, ${(report.duration * 1000).toFixed(1)} ms. ${report.wavScale < 1 ? `Peak normalization multiplies samples by ${report.wavScale.toFixed(5)}.` : 'No peak normalization needed.'} Listening is attenuated and briefly faded.`;
  inspectBin();
}
function inspectBin() {
  if (!report) return;
  const k = numeric('bin'),
    a = report.rectangular.bins[k],
    b = report.hann.bins[k];
  $('bin-readout').textContent =
    `Bin ${k} / ${a.frequency.toFixed(3)} Hz\nRectangular: ${a.amplitude.toFixed(6)} (${a.db.toFixed(2)} dB)\nHann: ${b.amplitude.toFixed(6)} (${b.db.toFixed(2)} dB)`;
  const root = $('spectrum-plot').querySelector('svg');
  if (!root) return;
  const max = Number(root.dataset.xmax),
    low = Number(root.dataset.ymin),
    high = Number(root.dataset.ymax),
    width = root.viewBox.baseVal.width,
    height = root.viewBox.baseVal.height;
  let cursor = root.querySelector('.bin-cursor');
  if (!cursor) {
    cursor = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    cursor.setAttribute('class', 'bin-cursor');
    cursor.setAttribute('aria-hidden', 'true');
    cursor.innerHTML =
      '<rect class="bin-band" y="16" width="12"/><line class="bin-guide" y1="16"/><circle class="bin-rect-point" r="4"/><circle class="bin-hann-point" r="4"/>';
    root.append(cursor);
  }
  const outside = a.frequency > max;
  cursor.setAttribute('visibility', outside ? 'hidden' : 'visible');
  if (outside) {
    $('bin-readout').textContent += '\nOutside displayed frequency range';
    return;
  }
  const x = 48 + (a.frequency / max) * (width - 66),
    y = (value) =>
      16 + ((high - Math.max(low, Math.min(high, value))) / (high - low)) * (height - 48);
  cursor.setAttribute('transform', `translate(${x},0)`);
  const band = cursor.querySelector('rect');
  band.setAttribute('x', '-6');
  band.setAttribute('height', height - 48);
  cursor.querySelector('line').setAttribute('y2', height - 32);
  cursor
    .querySelector('.bin-rect-point')
    .setAttribute('cy', y($('scale').value === 'db' ? a.db : a.amplitude));
  cursor
    .querySelector('.bin-hann-point')
    .setAttribute('cy', y($('scale').value === 'db' ? b.db : b.amplitude));
}
$('signal-form').addEventListener('submit', (event) => {
  event.preventDefault();
  generate();
});
for (const id of [
  'sample-rate',
  'count',
  'frequency-a',
  'amplitude-a',
  'frequency-b',
  'amplitude-b',
  'noise',
  'offset',
  'seed',
])
  $(id).addEventListener('input', invalidate);
for (const id of ['scale', 'range', 'peak-window']) $(id).addEventListener('change', render);
$('bin').addEventListener('input', inspectBin);
$('spectrum-plot').addEventListener('pointermove', (event) => {
  if (!report) return;
  const svg = $('spectrum-plot').querySelector('svg');
  if (!svg) return;
  const rect = svg.getBoundingClientRect(),
    width = svg.viewBox.baseVal.width,
    x = ((event.clientX - rect.left) / rect.width) * width,
    ratio = Math.max(0, Math.min(1, (x - 48) / (width - 48 - 18))),
    range = numeric('range') ? Math.min(numeric('range'), report.nyquist) : report.nyquist;
  $('bin').value = Math.round((ratio * range) / report.binWidth);
  inspectBin();
});
function example() {
  const settings = examples[$('example').value];
  for (const [id, key] of [
    ['sample-rate', 'sampleRate'],
    ['count', 'count'],
    ['noise', 'noise'],
    ['offset', 'offset'],
    ['seed', 'seed'],
  ])
    $(id).value = settings[key];
  for (const [i, suffix] of ['a', 'b'].entries()) {
    $('frequency-' + suffix).value = settings.tones[i].frequency;
    $('amplitude-' + suffix).value = settings.tones[i].amplitude;
  }
  generate();
}
$('example').addEventListener('change', example);
function download(name, value, type) {
  const url = URL.createObjectURL(new Blob([value], { type })),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('save-samples').addEventListener('click', () => {
  if (report) download('signal-samples.csv', report.samples.join('\n'), 'text/csv');
});
$('save-report').addEventListener('click', () => {
  if (report) download('signal-analysis.json', JSON.stringify(report, null, 2), 'application/json');
});
$('save-wav').addEventListener('click', () => {
  if (report) download('signal.wav', wav(report.samples, report.sampleRate).buffer, 'audio/wav');
});
$('import').addEventListener('change', async () => {
  const file = $('import').files[0];
  $('import').value = '';
  if (!file) return;
  const version = ++revision;
  stopAudio();
  try {
    if (file.size > 400000) throw Error('Sample file exceeds 400 KB.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    const samples = parseSamples(text);
    analyze(samples, numeric('sample-rate'));
    if (version !== revision) return;
    $('count').value = samples.length;
    setReport(samples, 'IMPORTED SAMPLES');
  } catch (error) {
    if (version === revision)
      notice('Import failed: ' + error.message + ' Current analysis is unchanged.', true);
  }
});
$('listen').addEventListener('click', async () => {
  if (playback) {
    stopAudio();
    return;
  }
  if (!report) return;
  const version = revision,
    current = report,
    ticket = ++audioTicket;
  try {
    audioContext ??= new AudioContext();
    await audioContext.resume();
    if (ticket !== audioTicket || version !== revision || report !== current) return;
    const buffer = audioContext.createBuffer(1, current.count, current.sampleRate);
    buffer.getChannelData(0).set(current.samples);
    const source = audioContext.createBufferSource(),
      gain = audioContext.createGain();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(audioContext.destination);
    const now = audioContext.currentTime,
      fade = Math.min(0.01, current.duration / 4),
      level = 0.15 / Math.max(1, current.peak);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + fade);
    gain.gain.setValueAtTime(level, now + current.duration - fade);
    gain.gain.linearRampToValueAtTime(0, now + current.duration);
    source.onended = () => {
      if (playback === source) {
        playback = null;
        playbackGain = null;
        $('listen').textContent = 'Listen once ▷';
      }
      source.disconnect();
      gain.disconnect();
    };
    playback = source;
    playbackGain = gain;
    $('listen').textContent = 'Stop preview ■';
    source.start();
  } catch (error) {
    if (ticket === audioTicket) stopAudio();
    notice('Audio preview unavailable: ' + error.message, true);
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAudio();
});
example();

for (const [button, panel] of [
  ['measurements-open', 'measurements'],
  ['files-open', 'file-panel'],
])
  $(button).onclick = () => $(panel).showModal();
for (const b of document.querySelectorAll('[data-close]'))
  b.onclick = () => $(b.dataset.close).close();

new ResizeObserver(() => {
  if (report) render();
}).observe($('wave-plot'));
