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
const workInput    = document.getElementById('workMin');
const breakInput   = document.getElementById('breakMin');

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
    if (saved.soundVolumes) {
      Object.entries(saved.soundVolumes).forEach(([k, v]) => {
        if (soundState[k] && typeof v === 'number') soundState[k].volume = v;
      });
    }

    workInput.value  = state.workMin;
    breakInput.value = state.breakMin;
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

function render() {
  timeEl.textContent = formatTime(state.remaining);
  phaseEl.textContent = state.phase === 'focus' ? 'Focus' : 'Break';
  sessionCount.textContent = state.sessionsToday;
  startBtn.textContent = state.running ? 'Pause' : 'Start';

  const elapsed = state.totalForPhase - state.remaining;
  const fraction = elapsed / state.totalForPhase;
  ringProgress.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - fraction);
  ringWaveEl.style.strokeDashoffset   = WAVE_LENGTH * (1 - fraction);

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

  // Splash body: white noise band-limited to the "hiss" range
  const white = makeWhiteNoiseSource(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 400;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';  lp.frequency.value = 4000;
  const whiteGain = ctx.createGain(); whiteGain.gain.value = 0.5;
  white.connect(hp); hp.connect(lp); lp.connect(whiteGain); whiteGain.connect(bus);

  // Surface body: deep brown for the "on water" feel
  const brown = makeBrownNoiseSource(ctx);
  const brownLP = ctx.createBiquadFilter();
  brownLP.type = 'lowpass'; brownLP.frequency.value = 250;
  const brownGain = ctx.createGain(); brownGain.gain.value = 0.25;
  brown.connect(brownLP); brownLP.connect(brownGain); brownGain.connect(bus);

  // Subtle ebb so it doesn't feel static
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.06;
  const lfoDepth = ctx.createGain();  lfoDepth.gain.value = 0.1;
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
  windLP.type = 'lowpass'; windLP.frequency.value = 280;
  const windGain = ctx.createGain(); windGain.gain.value = 0.1;
  wind.connect(windLP); windLP.connect(windGain); windGain.connect(bus);
  wind.start();

  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
  const lfoDepth = ctx.createGain();  lfoDepth.gain.value = 0.06;
  lfo.connect(lfoDepth); lfoDepth.connect(windGain.gain);
  lfo.start();

  // Distant rumble: brief envelope on heavily low-passed brown noise
  let timeoutId = null;
  let stopped = false;

  function triggerRumble() {
    if (stopped) return;
    const now = ctx.currentTime;
    const duration = 2.5 + Math.random() * 3.5;
    const rumble = makeBrownNoiseSource(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 90 + Math.random() * 70;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.55 + Math.random() * 0.35, now + 0.4 + Math.random() * 0.5);
    env.gain.exponentialRampToValueAtTime(0.001, now + duration);
    rumble.connect(filter); filter.connect(env); env.connect(bus);
    rumble.start(now);
    rumble.stop(now + duration + 0.2);
  }

  function scheduleNext() {
    if (stopped) return;
    const delay = 16000 + Math.random() * 26000; // 16–42s
    timeoutId = setTimeout(() => { triggerRumble(); scheduleNext(); }, delay);
  }

  // First rumble a few seconds in
  timeoutId = setTimeout(() => { triggerRumble(); scheduleNext(); }, 4000 + Math.random() * 4000);

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
function playChime() {
  ensureAudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const now = audioCtx.currentTime;
  const tones = [528, 792];
  tones.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.05 + i * 0.1);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 2.5 + i * 0.2);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now + i * 0.1);
    osc.stop(now + 3.0);
  });
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
  });
});

document.querySelectorAll('.sound-volume').forEach(slider => {
  slider.addEventListener('input', (e) => {
    const id = e.target.dataset.sound;
    setSoundVolume(id, parseInt(e.target.value, 10));
  });
});

masterSlider.addEventListener('input', (e) => {
  setMasterVolume(parseInt(e.target.value, 10));
});

workInput.addEventListener('change', (e) => {
  const v = Math.max(1, Math.min(120, parseInt(e.target.value, 10) || 25));
  state.workMin = v;
  workInput.value = v;
  if (state.phase === 'focus' && !state.running) {
    state.remaining = v * 60;
    state.totalForPhase = v * 60;
    render();
  }
  saveState();
});

breakInput.addEventListener('change', (e) => {
  const v = Math.max(1, Math.min(60, parseInt(e.target.value, 10) || 5));
  state.breakMin = v;
  breakInput.value = v;
  if (state.phase === 'break' && !state.running) {
    state.remaining = v * 60;
    state.totalForPhase = v * 60;
    render();
  }
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
animateWave();
