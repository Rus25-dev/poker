// Звук: синтез на WebAudio без внешних файлов — шелест карт, стук фишек, сигнал хода, фанфары
let ctx = null, noiseBuf = null;
export const soundPrefs = { on: true, vibrate: true };

function ac() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function noise(dur, freq, q, vol, delay = 0, type = 'bandpass') {
  const c = ac(), t = c.currentTime + delay;
  const src = c.createBufferSource(); src.buffer = noiseBuf;
  const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(c.destination);
  src.start(t, Math.random() * 0.3); src.stop(t + dur + 0.02);
}
function tone(freq, dur, vol, delay = 0, type = 'sine') {
  const c = ac(), t = c.currentTime + delay;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
}
const safe = f => (...a) => { if (!soundPrefs.on) return; try { f(...a); } catch { /* звук недоступен */ } };
const vib = p => { if (soundPrefs.vibrate && navigator.vibrate) try { navigator.vibrate(p); } catch { /* */ } };

export const SND = {
  card: safe((delay = 0) => { noise(0.07, 3200, 0.8, 0.25, delay, 'highpass'); noise(0.05, 1500, 1.2, 0.12, delay + 0.01); }),
  deal: safe(n => { for (let i = 0; i < n; i++) SND.card(i * 0.07); }),
  flip: safe(() => { noise(0.09, 2400, 0.7, 0.28, 0, 'highpass'); }),
  chip: safe((n = 3) => { for (let i = 0; i < n; i++) { tone(2600 + Math.random() * 900, 0.05, 0.05, i * 0.045, 'triangle'); noise(0.03, 5000, 2, 0.08, i * 0.045); } }),
  stack: safe(() => { for (let i = 0; i < 7; i++) { tone(2200 + Math.random() * 1400, 0.05, 0.04, i * 0.035, 'triangle'); noise(0.025, 4500, 2, 0.06, i * 0.035); } }),
  check: safe(() => { noise(0.05, 300, 1, 0.35, 0, 'lowpass'); noise(0.05, 300, 1, 0.3, 0.11, 'lowpass'); }),
  fold: safe(() => { noise(0.18, 1800, 0.5, 0.15); }),
  turn: safe(() => { tone(880, 0.18, 0.09); tone(1318, 0.25, 0.08, 0.13); vib([50, 40, 50]); }),
  tick: safe(() => tone(1500, 0.03, 0.04, 0, 'square')),
  win: safe(() => { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, 0.08, i * 0.1, 'triangle')); vib([30, 30, 80]); }),
  allin: safe(() => { tone(220, 0.4, 0.08, 0, 'sawtooth'); tone(330, 0.4, 0.06, 0.05, 'sawtooth'); vib(120); }),
  unlock: () => { try { ac(); } catch { /* */ } }
};
