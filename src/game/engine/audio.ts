/* Procedural Web Audio — every SFX and the ambient music are synthesized in code
   (no audio files, no licensing). Must be init()'d from a user gesture (the Enter
   click resumes the AudioContext). Degrades silently if Web Audio is unavailable. */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let musicGain: GainNode | null = null;
let muted = false;
let dronesStarted = false;

function ensure(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = muted ? 0 : 0.55; master.connect(ctx.destination);
    musicGain = ctx.createGain(); musicGain.gain.value = 0.0001; musicGain.connect(master);
  } catch { ctx = null; }
  return ctx;
}

function noiseBuffer(c: AudioContext, dur: number): AudioBuffer {
  const n = Math.max(1, Math.floor(c.sampleRate * dur));
  const b = c.createBuffer(1, n, c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
function env(g: GainNode, t0: number, peak: number, attack: number, decay: number) {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}
function tone(freq: number, type: OscillatorType, dur: number, peak: number, slideTo?: number) {
  const c = ensure(); if (!c || !master) return;
  const t0 = c.currentTime;
  const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  const g = c.createGain(); env(g, t0, peak, 0.005, dur);
  o.connect(g).connect(master); o.start(t0); o.stop(t0 + dur + 0.06);
}
function noiseHit(dur: number, peak: number, freq: number, sweepTo?: number) {
  const c = ensure(); if (!c || !master) return;
  const t0 = c.currentTime;
  const src = c.createBufferSource(); src.buffer = noiseBuffer(c, dur);
  const f = c.createBiquadFilter(); f.type = "bandpass"; f.frequency.setValueAtTime(freq, t0); f.Q.value = 1.1;
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
  const g = c.createGain(); env(g, t0, peak, 0.004, dur);
  src.connect(f).connect(g).connect(master); src.start(t0); src.stop(t0 + dur + 0.06);
}

export const Audio = {
  init() { const c = ensure(); if (c && c.state === "suspended") c.resume().catch(() => {}); },
  isMuted() { return muted; },
  toggleMute() { muted = !muted; if (master) master.gain.value = muted ? 0 : 0.55; return muted; },

  sfx(name: string) {
    if (!ensure() || muted) return;
    switch (name) {
      case "melee":    noiseHit(0.15, 0.4, 1300, 3200); break;
      case "bow":      tone(880, "triangle", 0.12, 0.28, 460); noiseHit(0.07, 0.13, 2600); break;
      case "cast":     tone(440, "sawtooth", 0.2, 0.2, 1150); break;
      case "skill":    tone(300, "sawtooth", 0.3, 0.24, 920); break;
      case "hit":      noiseHit(0.12, 0.45, 620, 200); tone(150, "square", 0.09, 0.16, 80); break;
      case "coin":     tone(1320, "square", 0.06, 0.16); setTimeout(() => tone(1760, "square", 0.07, 0.14), 55); break;
      case "dash":     noiseHit(0.22, 0.28, 820, 2700); break;
      case "hurt":     tone(210, "square", 0.18, 0.3, 90); break;
      case "fireball": noiseHit(0.4, 0.55, 420, 120); tone(110, "sine", 0.4, 0.3, 48); break;
      case "extract":  [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, "triangle", 0.22, 0.2), i * 95)); break;
      case "death":    tone(330, "sawtooth", 0.7, 0.28, 70); break;
    }
  },

  startMusic() {
    const c = ensure(); if (!c || !master || !musicGain) return;
    musicGain.gain.cancelScheduledValues(c.currentTime);
    musicGain.gain.setValueAtTime(Math.max(0.0001, musicGain.gain.value), c.currentTime);
    musicGain.gain.exponentialRampToValueAtTime(0.1, c.currentTime + 2.5);
    if (dronesStarted) return;
    dronesStarted = true;
    const drone = (freq: number, detune: number) => {
      const o = c.createOscillator(); o.type = "sawtooth"; o.frequency.value = freq; o.detune.value = detune;
      const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 280;
      const lfo = c.createOscillator(); lfo.frequency.value = 0.05;
      const lg = c.createGain(); lg.gain.value = 110;
      lfo.connect(lg).connect(f.frequency); lfo.start();
      const g = c.createGain(); g.gain.value = 0.45;
      o.connect(f).connect(g).connect(musicGain!); o.start();
    };
    drone(55, -7); drone(82.4, 5); drone(110, 0);
    const notes = [220, 261.6, 329.6, 174.6, 196];
    window.setInterval(() => {
      if (muted || !c || !musicGain) return;
      const o = c.createOscillator(); o.type = "sine"; o.frequency.value = notes[(Math.random() * notes.length) | 0] * 2;
      const g = c.createGain(); env(g, c.currentTime, 0.05, 0.03, 1.7);
      o.connect(g).connect(musicGain); o.start(); o.stop(c.currentTime + 2);
    }, 4300);
  },

  duckMusic() {
    const c = ensure(); if (!c || !musicGain) return;
    musicGain.gain.cancelScheduledValues(c.currentTime);
    musicGain.gain.setValueAtTime(Math.max(0.0001, musicGain.gain.value), c.currentTime);
    musicGain.gain.exponentialRampToValueAtTime(0.03, c.currentTime + 0.6);
  }
};
