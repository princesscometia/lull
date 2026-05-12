/* =========================================================
   LULL — script.js
   Timer + mixer engine (Web Audio synthesized soundscapes)
   ========================================================= */

// ---------- DOM ----------
const timeEl       = document.getElementById('time');
const phaseEl      = document.getElementById('phase');
const startBtn     = document.getElementById('startBtn');
const resetBtn     = document.getElementById('resetBtn');
const skipBtn      = document.getElementById('skipBtn');
const sessionCount = document.getElementById('sessionCount');
const ringProgress = document.querySelector('.ring-progress');
const ringWaveEl   = document.getElementById('ringWave');
const masterSlider = document.getElementById('masterVolume');
const volValue     = document.getElementById('volValue');
const focusDurEl   = document.getElementById('focusDuration');
const breakDurEl   = document.getElementById('breakDuration');
const durationControls = document.querySelectorAll('.duration-control');
const chimeSlider  = document.getElementById('chimeVolume');
const chimeValueEl = document.getElementById('chimeVolumeValue');
const immersiveToggle = document.getElementById('immersiveToggle');
const presetsRow      = document.getElementById('presetsRow');
const presetSaveChip  = document.getElementById('presetSaveChip');
const presetSaveBtn   = document.getElementById('presetSaveBtn');
const presetSaveForm  = document.getElementById('presetSaveForm');
const presetSaveInput = document.getElementById('presetSaveInput');

// ---------- State ----------
const RING_CIRCUMFERENCE = 678.58; // 2 * π * 108

// Wave-line config (sinusoidal path weaving through the ring)
const WAVE_RADIUS    = 108;
const WAVE_AMPLITUDE = 5;
const WAVE_CYCLES    = 24;
const WAVE_SEGMENTS  = 360;
let   WAVE_LENGTH    = 0;
let   wavePhase      = 0;

const STORAGE_KEY = 'lull-state-v1';

const state = {
  phase: 'focus',
  running: false,
  remaining: 25 * 60,
  totalForPhase: 25 * 60,
  workMin: 25,
  breakMin: 5,
  sessionsToday: 0,
  lastDate: todayKey(),
  intervalId: null,
};

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// ---------- Soundscape state ----------
const soundState = {
  waves:      { active: false, volume: 60 },
  rain:       { active: false, volume: 50 },
  underwater: { active: false, volume: 55 },
  thunder:    { active: false, volume: 45 },
};

let masterVolume = 50;
// Chime volume is a 0-100 slider scaled to a max gain of 0.08 (the previous
// loud default) so users have full range from silent to original-loud.
let chimeVolume = 25;
let immersiveMode = false;

// ---------- Preset library ----------
const BUILTIN_PRESETS = [
  { id: 'quiet-cove',     label: 'Quiet Cove',     master: 50,
    sounds: { waves: 55, rain: 0,  underwater: 25, thunder: 0  }, active: ['waves', 'underwater'] },
  { id: 'light-rain',     label: 'Light Rain',     master: 50,
    sounds: { waves: 30, rain: 55, underwater: 0,  thunder: 0  }, active: ['waves', 'rain'] },
  { id: 'stormy-day',     label: 'Stormy Day',     master: 60,
    sounds: { waves: 70, rain: 50, underwater: 0,  thunder: 65 }, active: ['waves', 'rain', 'thunder'] },
  { id: 'distant-storm',  label: 'Distant Storm',  master: 55,
    sounds: { waves: 45, rain: 0,  underwater: 0,  thunder: 55 }, active: ['waves', 'thunder'] },
  { id: 'deep-dive',      label: 'Deep Dive',      master: 50,
    sounds: { waves: 20, rain: 0,  underwater: 80, thunder: 0  }, active: ['waves', 'underwater'] },
];

const CUSTOM_PRESETS_KEY = 'lull-custom-presets-v1';
let currentPresetId = null;
// Smart hybrid: linked if the first sound was started while a timer was running.
// Independent if the user started a mix while idle (pure ambience).
let mixLinkedToTimer = false;
const activeNodes = {};

// ---------- Persistence ----------
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);

    if (saved.lastDate !== todayKey()) {
      saved.sessionsToday = 0;
      saved.lastDate = todayKey();
    }

    state.workMin       = saved.workMin       ?? 25;
    state.breakMin      = saved.breakMin      ?? 5;
    state.sessionsToday = saved.sessionsToday ?? 0;
    state.lastDate      = saved.lastDate;

    if (typeof saved.masterVolume === 'number') masterVolume = saved.masterVolume;
    if (typeof saved.chimeVolume === 'number')  chimeVolume  = saved.chimeVolume;
    if (typeof saved.immersiveMode === 'boolean') immersiveMode = saved.immersiveMode;
    if (saved.soundVolumes) {
      Object.entries(saved.soundVolumes).forEach(([k, v]) => {
        if (soundState[k] && typeof v === 'number') soundState[k].volume = v;
      });
    }

    focusDurEl.textContent = state.workMin;
    breakDurEl.textContent = state.breakMin;
    chimeSlider.value      = chimeVolume;
    chimeValueEl.textContent = chimeVolume;
    state.remaining     = state.workMin * 60;
    state.totalForPhase = state.workMin * 60;
  } catch (e) {}
}

function saveState() {
  const toSave = {
    workMin: state.workMin,
    breakMin: state.breakMin,
    sessionsToday: state.sessionsToday,
    lastDate: state.lastDate,
    masterVolume,
    chimeVolume,
    immersiveMode,
    soundVolumes: Object.fromEntries(
      Object.entries(soundState).map(([k, v]) => [k, v.volume])
    ),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
}

// ---------- Render ----------
function formatTime(secs) {
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// Stroke visibility — keep the ring/wave hidden while there's no progress.
// Showing is immediate; hiding is delayed slightly past the 1s dashoffset
// transition so the shrink-back-to-empty animation plays out on reset.
let strokeHideTimeoutId = null;
function setStrokesVisible(visible) {
  if (strokeHideTimeoutId) {
    clearTimeout(strokeHideTimeoutId);
    strokeHideTimeoutId = null;
  }
  if (visible) {
    ringProgress.style.visibility = 'visible';
    ringWaveEl.style.visibility = 'visible';
  } else {
    strokeHideTimeoutId = setTimeout(() => {
      ringProgress.style.visibility = 'hidden';
      ringWaveEl.style.visibility = 'hidden';
      strokeHideTimeoutId = null;
    }, 1050);
  }
}

function render() {
  timeEl.textContent = formatTime(state.remaining);
  phaseEl.textContent = state.phase === 'focus' ? 'Focus' : 'Break';
  sessionCount.textContent = state.sessionsToday;
  startBtn.textContent = state.running ? 'Pause' : 'Start';

  const elapsed = state.totalForPhase - state.remaining;
  const fraction = elapsed / state.totalForPhase;
  ringProgress.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - fraction);
  ringWaveEl.style.strokeDashoffset   = WAVE_LENGTH * (1 - fraction);
  setStrokesVisible(fraction > 0);

  // Duration controls: highlight current phase, disable while running
  durationControls.forEach(c => {
    c.classList.toggle('active', c.dataset.phase === state.phase);
    c.classList.toggle('disabled', state.running);
  });

  document.title = `${formatTime(state.remaining)} · ${state.phase === 'focus' ? 'Focus' : 'Break'} — Lull`;
}

function renderSoundUI() {
  Object.keys(soundState).forEach(id => {
    const row = document.querySelector(`.mixer-row[data-sound="${id}"]`);
    if (!row) return;
    const toggleBtn = row.querySelector('.sound-row-toggle');
    toggleBtn.classList.toggle('active', soundState[id].active);
    const slider = row.querySelector('.sound-volume');
    if (parseInt(slider.value, 10) !== soundState[id].volume) {
      slider.value = soundState[id].volume;
    }
  });
  if (parseInt(masterSlider.value, 10) !== masterVolume) {
    masterSlider.value = masterVolume;
  }
  volValue.textContent = masterVolume;
}

// ---------- Wave-line around the ring ----------
function buildWavePath(phase) {
  const cx = 120, cy = 120;
  const parts = [];
  for (let i = 0; i <= WAVE_SEGMENTS; i++) {
    const t = i / WAVE_SEGMENTS;
    const angle = t * Math.PI * 2;
    const r = WAVE_RADIUS + WAVE_AMPLITUDE * Math.sin(WAVE_CYCLES * angle + phase);
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    parts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return parts.join(' ') + ' Z';
}

function initWave() {
  ringWaveEl.setAttribute('d', buildWavePath(0));
  WAVE_LENGTH = ringWaveEl.getTotalLength();
  ringWaveEl.style.strokeDasharray = WAVE_LENGTH;
  ringWaveEl.style.strokeDashoffset = WAVE_LENGTH;
}

function animateWave() {
  wavePhase += 0.012;
  ringWaveEl.setAttribute('d', buildWavePath(wavePhase));
  requestAnimationFrame(animateWave);
}

// ---------- Timer ----------
function anySoundActive() {
  return Object.values(soundState).some(s => s.active);
}

function tick() {
  if (state.remaining <= 0) {
    completePhase();
    return;
  }
  state.remaining -= 1;
  render();
}

function start() {
  if (state.running) return;
  state.running = true;
  state.intervalId = setInterval(tick, 1000);
  if (anySoundActive() && mixLinkedToTimer) unduckMix();
  render();
}

function pause() {
  if (!state.running) return;
  state.running = false;
  clearInterval(state.intervalId);
  state.intervalId = null;
  if (anySoundActive() && mixLinkedToTimer) duckMix();
  render();
}

function toggleStart() {
  if (state.running) pause();
  else start();
}

function reset() {
  pause();
  if (anySoundActive() && mixLinkedToTimer) {
    Object.keys(activeNodes).forEach(id => deactivateSound(id));
    mixLinkedToTimer = false;
  }
  state.remaining = state.phase === 'focus'
    ? state.workMin * 60
    : state.breakMin * 60;
  state.totalForPhase = state.remaining;
  render();
  renderSoundUI();
}

function completePhase() {
  pause();
  playChime();
  notify();

  if (state.phase === 'focus') {
    state.sessionsToday += 1;
    state.lastDate = todayKey();
    saveState();
    state.phase = 'break';
    state.remaining     = state.breakMin * 60;
    state.totalForPhase = state.breakMin * 60;
  } else {
    state.phase = 'focus';
    state.remaining     = state.workMin * 60;
    state.totalForPhase = state.workMin * 60;
  }
  render();
  setTimeout(() => start(), 1500);
}

function skip() {
  state.remaining = 0;
  completePhase();
}

// ---------- Notifications ----------
function notify() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  const title = state.phase === 'focus'
    ? 'Focus session complete'
    : 'Break complete — back to focus';
  new Notification(title, {
    body: state.phase === 'focus' ? 'Time for a short break.' : 'Drift back into focus.',
    silent: true,
  });
}

function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') Notification.requestPermission();
}

// =========================================================
//   AUDIO ENGINE
// =========================================================
//
// Signal flow:
//   each soundscape's source nodes
//       → its own bus (per-sound gain, tied to per-sound volume slider)
//           → masterGain (master volume slider)
//               → duckGain (1.0 normally, ramps to 0 when timer paused if linked)
//                   → destination
//
// The chime bypasses master/duck and goes straight to destination so it's
// always audible regardless of mix or pause state.

let audioCtx   = null;
let masterGain = null;
let duckGain   = null;

function ensureAudioContext() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  masterGain = audioCtx.createGain();
  masterGain.gain.value = masterVolume / 100 * 0.6;

  duckGain = audioCtx.createGain();
  duckGain.gain.value = 1.0;

  masterGain.connect(duckGain);
  duckGain.connect(audioCtx.destination);
}

// ---------- Noise generators ----------
function makeBrownNoiseSource(ctx) {
  const size = 2 * ctx.sampleRate;
  const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < size; i++) {
    const w = Math.random() * 2 - 1;
    data[i] = (last + 0.02 * w) / 1.02;
    last = data[i];
    data[i] *= 3.5;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  return src;
}

function makeWhiteNoiseSource(ctx) {
  const size = 2 * ctx.sampleRate;
  const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  return src;
}

// ---------- Soundscape factories ----------
//
// Each factory returns { bus, sources, cleanup? }. The bus is the per-sound
// gain node and is what the mixer routes through.

function createOceanWaves(ctx, dest) {
  const bus = ctx.createGain();
  bus.gain.value = 0;
  bus.connect(dest);

  // --- Layer 1: deep rumble (body of the wave) ---
  const brown = makeBrownNoiseSource(ctx);
  const brownLP = ctx.createBiquadFilter();
  brownLP.type = 'lowpass';
  brownLP.frequency.value = 600;
  const brownGain = ctx.createGain();
  brownGain.gain.value = 0.35;
  brown.connect(brownLP); brownLP.connect(brownGain); brownGain.connect(bus);

  // --- Layer 2: foam crests (bandpassed white noise, filter swept over time) ---
  const white = makeWhiteNoiseSource(ctx);
  const whiteBP = ctx.createBiquadFilter();
  whiteBP.type = 'bandpass';
  whiteBP.frequency.value = 1200;
  whiteBP.Q.value = 0.7;
  const foamGain = ctx.createGain();
  foamGain.gain.value = 0;
  white.connect(whiteBP); whiteBP.connect(foamGain); foamGain.connect(bus);

  // --- Layer 3: distant rolling waves (heavily low-passed, slow) ---
  const distantBrown = makeBrownNoiseSource(ctx);
  const distantLP = ctx.createBiquadFilter();
  distantLP.type = 'lowpass';
  distantLP.frequency.value = 200;
  const distantGain = ctx.createGain();
  distantGain.gain.value = 0.18;
  distantBrown.connect(distantLP); distantLP.connect(distantGain); distantGain.connect(bus);

  // --- LFOs with incommensurate frequencies → mix never quite repeats ---
  // Primary swell ~10s
  const lfo1 = ctx.createOscillator();
  lfo1.frequency.value = 0.1;
  // Secondary ~13.3s — intentionally not a multiple of lfo1
  const lfo2 = ctx.createOscillator();
  lfo2.frequency.value = 0.075;
  // Distant roll ~25s
  const lfo3 = ctx.createOscillator();
  lfo3.frequency.value = 0.04;
  // Filter sweep ~17s — varies foam character so crests don't sound identical
  const lfoFilter = ctx.createOscillator();
  lfoFilter.frequency.value = 0.058;

  // Brown rumble modulated by both lfo1 + lfo2 (sometimes reinforce, sometimes cancel)
  const lfo1Brown = ctx.createGain(); lfo1Brown.gain.value = 0.18;
  const lfo2Brown = ctx.createGain(); lfo2Brown.gain.value = 0.1;
  lfo1.connect(lfo1Brown); lfo1Brown.connect(brownGain.gain);
  lfo2.connect(lfo2Brown); lfo2Brown.connect(brownGain.gain);

  // Foam follows the same two LFOs
  const lfo1Foam = ctx.createGain(); lfo1Foam.gain.value = 0.13;
  const lfo2Foam = ctx.createGain(); lfo2Foam.gain.value = 0.09;
  lfo1.connect(lfo1Foam); lfo1Foam.connect(foamGain.gain);
  lfo2.connect(lfo2Foam); lfo2Foam.connect(foamGain.gain);

  // Distant layer breathes on the slowest LFO
  const lfo3Distant = ctx.createGain(); lfo3Distant.gain.value = 0.09;
  lfo3.connect(lfo3Distant); lfo3Distant.connect(distantGain.gain);

  // Sweep the foam bandpass center freq ±400Hz around 1200Hz so crests vary in character
  const lfoFilterDepth = ctx.createGain(); lfoFilterDepth.gain.value = 400;
  lfoFilter.connect(lfoFilterDepth); lfoFilterDepth.connect(whiteBP.frequency);

  brown.start(); white.start(); distantBrown.start();
  lfo1.start(); lfo2.start(); lfo3.start(); lfoFilter.start();

  // --- Layer 4: occasional bigger crest (random scheduling) ---
  let stopped = false;
  let timeoutId = null;

  function triggerBigCrest() {
    if (stopped) return;
    const now = ctx.currentTime;
    const duration = 3.5 + Math.random() * 3;
    const crest = makeWhiteNoiseSource(ctx);
    const crestFilter = ctx.createBiquadFilter();
    crestFilter.type = 'bandpass';
    crestFilter.frequency.value = 900 + Math.random() * 700;
    crestFilter.Q.value = 0.5 + Math.random() * 0.4;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.15 + Math.random() * 0.13, now + 0.7 + Math.random() * 0.6);
    env.gain.linearRampToValueAtTime(0, now + duration);
    crest.connect(crestFilter); crestFilter.connect(env); env.connect(bus);
    crest.start(now);
    crest.stop(now + duration + 0.2);
  }

  function scheduleNextCrest() {
    if (stopped) return;
    const delay = 14000 + Math.random() * 20000; // 14–34s between bigger crests
    timeoutId = setTimeout(() => { triggerBigCrest(); scheduleNextCrest(); }, delay);
  }
  timeoutId = setTimeout(() => { triggerBigCrest(); scheduleNextCrest(); }, 6000 + Math.random() * 6000);

  return {
    bus,
    sources: [brown, white, distantBrown, lfo1, lfo2, lfo3, lfoFilter],
    cleanup: () => { stopped = true; if (timeoutId) clearTimeout(timeoutId); },
  };
}

function createRain(ctx, dest) {
  const bus = ctx.createGain();
  bus.gain.value = 0;
  bus.connect(dest);

  // Soft pitter-patter: narrow mid-band white noise.
  // Upper cutoff sits below the "harsh" 3-6kHz presence range, so the rain
  // feels gentle rather than hissy.
  const white = makeWhiteNoiseSource(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 850;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';  lp.frequency.value = 3200;
  const whiteGain = ctx.createGain(); whiteGain.gain.value = 0.18;
  white.connect(hp); hp.connect(lp); lp.connect(whiteGain); whiteGain.connect(bus);

  // Very subtle surface presence — just enough to feel like rain on water, not heavy
  const brown = makeBrownNoiseSource(ctx);
  const brownLP = ctx.createBiquadFilter();
  brownLP.type = 'lowpass'; brownLP.frequency.value = 200;
  const brownGain = ctx.createGain(); brownGain.gain.value = 0.06;
  brown.connect(brownLP); brownLP.connect(brownGain); brownGain.connect(bus);

  // Gentle ebb so it doesn't feel static
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.06;
  const lfoDepth = ctx.createGain();  lfoDepth.gain.value = 0.05;
  lfo.connect(lfoDepth); lfoDepth.connect(whiteGain.gain);

  brown.start(); white.start(); lfo.start();
  return { bus, sources: [brown, white, lfo] };
}

function createUnderwater(ctx, dest) {
  const bus = ctx.createGain();
  bus.gain.value = 0;
  bus.connect(dest);

  // Two stacked low-pass filters → very deep, submerged sound
  const brown = makeBrownNoiseSource(ctx);
  const lp1 = ctx.createBiquadFilter(); lp1.type = 'lowpass'; lp1.frequency.value = 250;
  const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 120;
  const brownGain = ctx.createGain(); brownGain.gain.value = 0.75;
  brown.connect(lp1); lp1.connect(lp2); lp2.connect(brownGain); brownGain.connect(bus);

  // Sub-bass drone
  const sub = ctx.createOscillator();
  sub.type = 'sine'; sub.frequency.value = 65;
  const subGain = ctx.createGain(); subGain.gain.value = 0.05;
  sub.connect(subGain); subGain.connect(bus);

  // Very slow breathing
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.04;
  const lfoDepth = ctx.createGain();  lfoDepth.gain.value = 0.18;
  lfo.connect(lfoDepth); lfoDepth.connect(brownGain.gain);

  brown.start(); sub.start(); lfo.start();
  return { bus, sources: [brown, sub, lfo] };
}

function createThunder(ctx, dest) {
  const bus = ctx.createGain();
  bus.gain.value = 0;
  bus.connect(dest);

  // Quiet wind bed so it's not silent between rumbles
  const wind = makeBrownNoiseSource(ctx);
  const windLP = ctx.createBiquadFilter();
  windLP.type = 'lowpass'; windLP.frequency.value = 320;
  const windGain = ctx.createGain(); windGain.gain.value = 0.16;
  wind.connect(windLP); windLP.connect(windGain); windGain.connect(bus);
  wind.start();

  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
  const lfoDepth = ctx.createGain();  lfoDepth.gain.value = 0.08;
  lfo.connect(lfoDepth); lfoDepth.connect(windGain.gain);
  lfo.start();

  // Rumbles come in three flavors:
  //  - distant (~55%): low cutoff, slower attack, classic rolling rumble
  //  - closer (~30%): higher cutoff, faster attack, more present and impactful
  //  - long roll (~15%): extended 9-14s rumble that builds, sustains, then trails off,
  //    with the filter cutoff sweeping downward so it feels like the sound is moving away
  let timeoutId = null;
  let stopped = false;

  function triggerDistant(now) {
    const duration = 3.5 + Math.random() * 4;
    const rumble = makeBrownNoiseSource(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 180 + Math.random() * 140;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.85 + Math.random() * 0.4, now + 0.4 + Math.random() * 0.5);
    env.gain.exponentialRampToValueAtTime(0.001, now + duration);
    rumble.connect(filter); filter.connect(env); env.connect(bus);
    rumble.start(now);
    rumble.stop(now + duration + 0.2);
  }

  function triggerCloser(now) {
    const duration = 3 + Math.random() * 3;
    const rumble = makeBrownNoiseSource(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 380 + Math.random() * 240;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(1.0 + Math.random() * 0.4, now + 0.2 + Math.random() * 0.3);
    env.gain.exponentialRampToValueAtTime(0.001, now + duration);
    rumble.connect(filter); filter.connect(env); env.connect(bus);
    rumble.start(now);
    rumble.stop(now + duration + 0.2);
  }

  function triggerLongRoll(now) {
    const duration = 9 + Math.random() * 5;          // 9-14s
    const attack   = 1.2 + Math.random() * 0.8;      // gradual build (1.2-2s)
    const sustainPoint = duration * (0.55 + Math.random() * 0.15);
    const peak     = 0.75 + Math.random() * 0.3;

    // Two stacked brown sources for added thickness
    const r1 = makeBrownNoiseSource(ctx);
    const r2 = makeBrownNoiseSource(ctx);

    // Filter cutoff sweeps downward over the duration → sound recedes into the distance
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const startFreq = 280 + Math.random() * 100;
    const endFreq   = 130 + Math.random() * 30;
    filter.frequency.setValueAtTime(startFreq, now);
    filter.frequency.linearRampToValueAtTime(endFreq, now + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(peak, now + attack);
    env.gain.linearRampToValueAtTime(peak * 0.9, now + sustainPoint);
    env.gain.exponentialRampToValueAtTime(0.001, now + duration);

    r1.connect(filter); r2.connect(filter); filter.connect(env); env.connect(bus);
    r1.start(now); r2.start(now);
    r1.stop(now + duration + 0.3);
    r2.stop(now + duration + 0.3);
  }

  function triggerRumble() {
    if (stopped) return;
    const r = Math.random();
    const now = ctx.currentTime;
    if (r < 0.55)      triggerDistant(now);
    else if (r < 0.85) triggerCloser(now);
    else               triggerLongRoll(now);
  }

  function scheduleNext() {
    if (stopped) return;
    const delay = 9000 + Math.random() * 14000; // 9–23s, ~2x more frequent
    timeoutId = setTimeout(() => { triggerRumble(); scheduleNext(); }, delay);
  }

  // First rumble a few seconds in
  timeoutId = setTimeout(() => { triggerRumble(); scheduleNext(); }, 3000 + Math.random() * 3000);

  return {
    bus,
    sources: [wind, lfo],
    cleanup: () => { stopped = true; if (timeoutId) clearTimeout(timeoutId); },
  };
}

const soundFactories = {
  waves: createOceanWaves,
  rain: createRain,
  underwater: createUnderwater,
  thunder: createThunder,
};

// ---------- Mixer control ----------
function activateSound(id) {
  ensureAudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (activeNodes[id]) return;

  const factory = soundFactories[id];
  if (!factory) return;

  const wasEmpty = Object.keys(activeNodes).length === 0;
  const nodes = factory(audioCtx, masterGain);
  activeNodes[id] = nodes;

  const now = audioCtx.currentTime;
  const target = soundState[id].volume / 100;
  nodes.bus.gain.cancelScheduledValues(now);
  nodes.bus.gain.setValueAtTime(0, now);
  nodes.bus.gain.linearRampToValueAtTime(target, now + 1.5);

  soundState[id].active = true;
  if (wasEmpty) mixLinkedToTimer = state.running;

  saveState();
}

function deactivateSound(id) {
  const nodes = activeNodes[id];
  if (!nodes) return;

  // Mark inactive immediately so re-activation sees fresh state.
  delete activeNodes[id];
  soundState[id].active = false;

  const now = audioCtx.currentTime;
  nodes.bus.gain.cancelScheduledValues(now);
  nodes.bus.gain.setValueAtTime(nodes.bus.gain.value, now);
  nodes.bus.gain.linearRampToValueAtTime(0, now + 1.0);

  setTimeout(() => {
    try {
      nodes.sources.forEach(s => { try { s.stop(); } catch (e) {} });
      if (nodes.cleanup) nodes.cleanup();
    } catch (e) {}
  }, 1100);

  if (Object.keys(activeNodes).length === 0) mixLinkedToTimer = false;
  saveState();
}

function toggleSoundById(id) {
  if (soundState[id].active) deactivateSound(id);
  else activateSound(id);
  renderSoundUI();
}

function setSoundVolume(id, vol) {
  soundState[id].volume = vol;
  const nodes = activeNodes[id];
  if (nodes && audioCtx) {
    nodes.bus.gain.setTargetAtTime(vol / 100, audioCtx.currentTime, 0.05);
  }
  saveState();
}

function setMasterVolume(vol) {
  masterVolume = vol;
  if (masterGain && audioCtx) {
    masterGain.gain.setTargetAtTime(vol / 100 * 0.6, audioCtx.currentTime, 0.05);
  }
  volValue.textContent = vol;
  saveState();
}

// ---------- Duck / unduck (pause-linked mix) ----------
function duckMix() {
  if (!duckGain) return;
  const now = audioCtx.currentTime;
  duckGain.gain.cancelScheduledValues(now);
  duckGain.gain.setValueAtTime(duckGain.gain.value, now);
  duckGain.gain.linearRampToValueAtTime(0, now + 1.2);
}

function unduckMix() {
  if (!duckGain) return;
  const now = audioCtx.currentTime;
  duckGain.gain.cancelScheduledValues(now);
  duckGain.gain.setValueAtTime(duckGain.gain.value, now);
  duckGain.gain.linearRampToValueAtTime(1.0, now + 1.5);
}

// ---------- Chime (always audible — bypasses master + duck) ----------
// Envelope: silent → linear attack → exponential decay → linear fade to absolute 0.
// The final linear fade prevents the tail "click" you get when an oscillator stops
// while its gain is still non-zero (exponential decay can't reach exactly 0).
function playChime() {
  const peak = (chimeVolume / 100) * 0.08;
  if (peak < 0.0005) return; // effectively muted

  ensureAudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const now = audioCtx.currentTime;
  const tones = [528, 792];
  tones.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const start     = now + i * 0.1;
    const attackEnd = now + 0.05 + i * 0.1;
    const decayEnd  = now + 2.5  + i * 0.2;
    const fadeEnd   = now + 3.3  + i * 0.2;

    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, attackEnd);
    gain.gain.exponentialRampToValueAtTime(0.0005, decayEnd);
    gain.gain.linearRampToValueAtTime(0, fadeEnd);

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(start);
    osc.stop(fadeEnd + 0.1);
  });
}

// =========================================================
//   PRESETS
// =========================================================

function getCustomPresets() {
  try {
    const raw = localStorage.getItem(CUSTOM_PRESETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function writeCustomPresets(list) {
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(list));
}

function applyPreset(preset) {
  // Master volume
  masterVolume = preset.master;
  masterSlider.value = masterVolume;
  volValue.textContent = masterVolume;
  if (masterGain && audioCtx) {
    masterGain.gain.setTargetAtTime(masterVolume / 100 * 0.6, audioCtx.currentTime, 0.05);
  }

  // Per-sound volumes (update state + live bus gain without saving each one)
  Object.entries(preset.sounds).forEach(([id, vol]) => {
    if (!soundState[id]) return;
    soundState[id].volume = vol;
    const nodes = activeNodes[id];
    if (nodes && audioCtx) {
      nodes.bus.gain.setTargetAtTime(vol / 100, audioCtx.currentTime, 0.05);
    }
  });

  // Activate / deactivate to match the preset's active list
  const wantActive = new Set(preset.active);
  Object.keys(soundState).forEach(id => {
    const isActive = soundState[id].active;
    if (wantActive.has(id) && !isActive)  activateSound(id);
    if (!wantActive.has(id) && isActive)  deactivateSound(id);
  });

  currentPresetId = preset.id;
  saveState();
  renderSoundUI();
  renderPresets();
}

function saveCurrentMixAs(name) {
  const clean = name.trim();
  if (!clean) return;
  const list = getCustomPresets();
  const preset = {
    id: 'custom-' + Date.now(),
    label: clean.slice(0, 24),
    master: masterVolume,
    sounds: {
      waves:      soundState.waves.volume,
      rain:       soundState.rain.volume,
      underwater: soundState.underwater.volume,
      thunder:    soundState.thunder.volume,
    },
    active: Object.entries(soundState).filter(([, s]) => s.active).map(([id]) => id),
  };
  list.push(preset);
  writeCustomPresets(list);
  currentPresetId = preset.id;
  renderPresets();
}

function deleteCustomPreset(id) {
  const list = getCustomPresets().filter(p => p.id !== id);
  writeCustomPresets(list);
  if (currentPresetId === id) currentPresetId = null;
  renderPresets();
}

function makeChip(preset, isCustom) {
  if (isCustom) {
    const wrap = document.createElement('div');
    wrap.className = 'preset-chip-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-chip custom' + (currentPresetId === preset.id ? ' active' : '');
    btn.textContent = preset.label;
    btn.addEventListener('click', () => {
      applyPreset(preset);
      bumpChip(btn);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'preset-delete';
    del.setAttribute('aria-label', `Delete preset ${preset.label}`);
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteCustomPreset(preset.id);
    });

    wrap.appendChild(btn);
    wrap.appendChild(del);
    return wrap;
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'preset-chip' + (currentPresetId === preset.id ? ' active' : '');
  btn.textContent = preset.label;
  btn.addEventListener('click', () => {
    applyPreset(preset);
    bumpChip(btn);
  });
  return btn;
}

function bumpChip(el) {
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
  setTimeout(() => el.classList.remove('bump'), 200);
}

function renderPresets() {
  // Remove all existing chips except the save chip
  presetsRow.querySelectorAll('.preset-chip, .preset-chip-wrap').forEach(el => el.remove());

  // Built-ins first
  BUILTIN_PRESETS.forEach(p => presetsRow.insertBefore(makeChip(p, false), presetSaveChip));

  // Then any custom presets
  getCustomPresets().forEach(p => presetsRow.insertBefore(makeChip(p, true), presetSaveChip));
}

// Clear current-preset highlight when user manually edits the mix
function noteMixDirtied() {
  if (currentPresetId !== null) {
    currentPresetId = null;
    renderPresets();
  }
}

// =========================================================
//   EVENT LISTENERS
// =========================================================

startBtn.addEventListener('click', () => {
  toggleStart();
  requestNotificationPermission();
});

resetBtn.addEventListener('click', reset);
skipBtn.addEventListener('click', skip);

document.querySelectorAll('.sound-row-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const row = btn.closest('.mixer-row');
    if (!row) return;
    toggleSoundById(row.dataset.sound);
    noteMixDirtied();
  });
});

document.querySelectorAll('.sound-volume').forEach(slider => {
  slider.addEventListener('input', (e) => {
    const id = e.target.dataset.sound;
    setSoundVolume(id, parseInt(e.target.value, 10));
    noteMixDirtied();
  });
});

masterSlider.addEventListener('input', (e) => {
  setMasterVolume(parseInt(e.target.value, 10));
  noteMixDirtied();
});

// ---------- Save preset flow ----------
presetSaveBtn.addEventListener('click', () => {
  presetSaveChip.classList.add('saving');
  presetSaveInput.value = '';
  presetSaveInput.focus();
});

presetSaveForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = presetSaveInput.value.trim();
  presetSaveChip.classList.remove('saving');
  if (name) saveCurrentMixAs(name);
});

presetSaveInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    presetSaveChip.classList.remove('saving');
  }
});

presetSaveInput.addEventListener('blur', () => {
  // Cancel if blurred without committing
  setTimeout(() => presetSaveChip.classList.remove('saving'), 100);
});

// ---------- Duration controls (wheel / click / keyboard) ----------
function adjustDuration(phase, delta) {
  if (state.running) return; // can't change mid-session

  if (phase === 'focus') {
    const v = Math.max(1, Math.min(120, state.workMin + delta));
    if (v === state.workMin) return;
    state.workMin = v;
    focusDurEl.textContent = v;
    focusDurEl.closest('.duration-control').setAttribute('aria-valuenow', v);
    if (state.phase === 'focus') {
      state.remaining = v * 60;
      state.totalForPhase = v * 60;
      render();
    }
    bumpNumber(focusDurEl);
  } else {
    const v = Math.max(1, Math.min(60, state.breakMin + delta));
    if (v === state.breakMin) return;
    state.breakMin = v;
    breakDurEl.textContent = v;
    breakDurEl.closest('.duration-control').setAttribute('aria-valuenow', v);
    if (state.phase === 'break') {
      state.remaining = v * 60;
      state.totalForPhase = v * 60;
      render();
    }
    bumpNumber(breakDurEl);
  }
  saveState();
}

function bumpNumber(el) {
  el.classList.remove('bump');
  // Force reflow so the animation restarts cleanly on rapid changes
  void el.offsetWidth;
  el.classList.add('bump');
  setTimeout(() => el.classList.remove('bump'), 180);
}

durationControls.forEach(control => {
  const phase = control.dataset.phase;

  // Mouse wheel — accumulate so the control isn't twitchy on high-DPI trackpads
  let wheelAccum = 0;
  control.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (state.running) return;
    wheelAccum += e.deltaY;
    if (Math.abs(wheelAccum) >= 24) {
      adjustDuration(phase, wheelAccum > 0 ? -1 : 1);
      wheelAccum = 0;
    }
  }, { passive: false });

  // Chevron click
  control.querySelectorAll('.wheel-arrow').forEach(arrow => {
    arrow.addEventListener('click', (e) => {
      e.stopPropagation();
      adjustDuration(phase, arrow.dataset.dir === 'up' ? 1 : -1);
    });
  });

  // Keyboard when focused: arrows = ±1, shift+arrows = ±5
  control.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      adjustDuration(phase, e.shiftKey ? 5 : 1);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      adjustDuration(phase, e.shiftKey ? -5 : -1);
    }
  });
});

chimeSlider.addEventListener('input', (e) => {
  chimeVolume = parseInt(e.target.value, 10);
  chimeValueEl.textContent = chimeVolume;
  saveState();
});

// ---------- Immersive mode ----------
function applyImmersive() {
  document.body.classList.toggle('immersive', immersiveMode);
  immersiveToggle.classList.toggle('active', immersiveMode);
  immersiveToggle.setAttribute('aria-pressed', String(immersiveMode));
}

immersiveToggle.addEventListener('click', () => {
  immersiveMode = !immersiveMode;
  applyImmersive();
  saveState();
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    toggleStart();
  }
});

// ---------- Init ----------
loadState();
initWave();
render();
renderSoundUI();
renderPresets();
applyImmersive();
animateWave();
