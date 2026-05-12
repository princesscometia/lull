/* =========================================================
   LULL — script.js
   Timer logic + synthesized ocean wave audio
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
const soundToggle  = document.getElementById('soundToggle');
const soundLabel   = document.getElementById('soundLabel');
const volumeSlider = document.getElementById('volume');
const volValue     = document.getElementById('volValue');
const workInput    = document.getElementById('workMin');
const breakInput   = document.getElementById('breakMin');

// ---------- State ----------
const RING_CIRCUMFERENCE = 678.58; // 2 * π * 108

// Wave-line config (sinusoidal path weaving through the ring)
const WAVE_RADIUS    = 108;  // same mean radius as the ring → wave crosses through it
const WAVE_AMPLITUDE = 5;
const WAVE_CYCLES    = 24;   // integer → path closes cleanly
const WAVE_SEGMENTS  = 360;
let   WAVE_LENGTH    = 0;    // measured after first build
let   wavePhase      = 0;

const STORAGE_KEY = 'lull-state-v1';

const state = {
  phase: 'focus',          // 'focus' | 'break'
  running: false,
  remaining: 25 * 60,      // seconds left in current phase
  totalForPhase: 25 * 60,  // for ring math
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

// ---------- Persistence ----------
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);

    // Reset session count if day rolled over
    if (saved.lastDate !== todayKey()) {
      saved.sessionsToday = 0;
      saved.lastDate = todayKey();
    }

    state.workMin       = saved.workMin       ?? 25;
    state.breakMin      = saved.breakMin      ?? 5;
    state.sessionsToday = saved.sessionsToday ?? 0;
    state.lastDate      = saved.lastDate;

    workInput.value  = state.workMin;
    breakInput.value = state.breakMin;
    state.remaining     = state.workMin * 60;
    state.totalForPhase = state.workMin * 60;
  } catch (e) {
    // ignore corrupt storage
  }
}

function saveState() {
  const toSave = {
    workMin: state.workMin,
    breakMin: state.breakMin,
    sessionsToday: state.sessionsToday,
    lastDate: state.lastDate,
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

  // Ring + wave fill clockwise as time elapses
  const elapsed = state.totalForPhase - state.remaining;
  const fraction = elapsed / state.totalForPhase;
  ringProgress.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - fraction);
  ringWaveEl.style.strokeDashoffset   = WAVE_LENGTH * (1 - fraction);

  // Update document title so it's visible in a different tab
  document.title = `${formatTime(state.remaining)} · ${state.phase === 'focus' ? 'Focus' : 'Break'} — Lull`;
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
  ringWaveEl.style.strokeDashoffset = WAVE_LENGTH; // start hidden
}

function animateWave() {
  // Slow phase drift → waves appear to travel gently around the ring
  wavePhase += 0.012;
  ringWaveEl.setAttribute('d', buildWavePath(wavePhase));
  requestAnimationFrame(animateWave);
}

// ---------- Timer ----------
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
  if (soundOn && soundLinkedToTimer) unduckSound();
  render();
}

function pause() {
  if (!state.running) return;
  state.running = false;
  clearInterval(state.intervalId);
  state.intervalId = null;
  if (soundOn && soundLinkedToTimer) duckSound();
  render();
}

function toggleStart() {
  if (state.running) pause();
  else start();
}

function reset() {
  pause();
  // Reset ends the session — if sound was linked to this session, stop it.
  // Independent ambience (toggled on while idle) is left alone.
  if (soundOn && soundLinkedToTimer) {
    stopOceanWaves();
    soundOn = false;
    soundLinkedToTimer = false;
    soundToggle.classList.remove('active');
  }
  state.remaining = state.phase === 'focus'
    ? state.workMin * 60
    : state.breakMin * 60;
  state.totalForPhase = state.remaining;
  render();
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
  // Auto-start the next phase after a short pause for breath
  setTimeout(() => start(), 1500);
}

function skip() {
  state.remaining = 0;
  // Run completion logic immediately
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
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// ---------- Audio: synthesized ocean waves ----------
// We synthesize ocean sounds with the Web Audio API:
//   - brown noise (deep rumble) for the body of the wave
//   - a slow LFO modulating the volume to mimic the ebb/flow of waves
//   - subtle high-passed white noise for the foam/crest
// No audio files needed — works completely offline.

let audioCtx = null;
let masterGain = null;
let waveNodes = null;
let soundOn = false;
// Smart hybrid: if sound was toggled on while a timer was running, it's
// "linked" — it follows the timer (pause→duck, resume→swell, reset→stop).
// If toggled on while idle, it's "independent" — pure ambience that ignores
// the timer until the user toggles it off manually.
let soundLinkedToTimer = false;

function ensureAudioContext() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = volumeSlider.value / 100 * 0.6; // cap so it never blasts
  masterGain.connect(audioCtx.destination);
}

function createBrownNoise() {
  const bufferSize = 2 * audioCtx.sampleRate;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  let lastOut = 0;
  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    data[i] = (lastOut + 0.02 * white) / 1.02;
    lastOut = data[i];
    data[i] *= 3.5;
  }
  const node = audioCtx.createBufferSource();
  node.buffer = buffer;
  node.loop = true;
  return node;
}

function createWhiteNoise() {
  const bufferSize = 2 * audioCtx.sampleRate;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  const node = audioCtx.createBufferSource();
  node.buffer = buffer;
  node.loop = true;
  return node;
}

function startOceanWaves() {
  ensureAudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (waveNodes) return;

  // Brown noise (low rumble) → low-pass filter → wave gain (LFO modulated)
  const brown = createBrownNoise();
  const brownLowpass = audioCtx.createBiquadFilter();
  brownLowpass.type = 'lowpass';
  brownLowpass.frequency.value = 600;

  const brownGain = audioCtx.createGain();
  brownGain.gain.value = 0.4;

  brown.connect(brownLowpass);
  brownLowpass.connect(brownGain);

  // White noise (foam crest) → band-pass filter → foam gain (LFO modulated, quieter)
  const white = createWhiteNoise();
  const whiteFilter = audioCtx.createBiquadFilter();
  whiteFilter.type = 'bandpass';
  whiteFilter.frequency.value = 1200;
  whiteFilter.Q.value = 0.7;

  const foamGain = audioCtx.createGain();
  foamGain.gain.value = 0.0;

  white.connect(whiteFilter);
  whiteFilter.connect(foamGain);

  // LFO that creates the slow swelling/receding wave envelope (~10s per cycle)
  const lfo = audioCtx.createOscillator();
  lfo.frequency.value = 0.1; // 0.1 Hz = 10 second period

  // Modulation depth for brown rumble
  const lfoBrownGain = audioCtx.createGain();
  lfoBrownGain.gain.value = 0.25;
  lfo.connect(lfoBrownGain);
  lfoBrownGain.connect(brownGain.gain);

  // Modulation depth for foam — louder when wave crests
  const lfoFoamGain = audioCtx.createGain();
  lfoFoamGain.gain.value = 0.18;
  lfo.connect(lfoFoamGain);
  lfoFoamGain.connect(foamGain.gain);

  // Combine into a wave bus
  const waveBus = audioCtx.createGain();
  waveBus.gain.value = 0.0;
  brownGain.connect(waveBus);
  foamGain.connect(waveBus);
  waveBus.connect(masterGain);

  // Fade in
  const now = audioCtx.currentTime;
  waveBus.gain.cancelScheduledValues(now);
  waveBus.gain.setValueAtTime(0, now);
  waveBus.gain.linearRampToValueAtTime(1.0, now + 1.5);

  brown.start();
  white.start();
  lfo.start();

  waveNodes = { brown, white, lfo, waveBus };
}

function stopOceanWaves() {
  if (!waveNodes) return;
  const { brown, white, lfo, waveBus } = waveNodes;
  const now = audioCtx.currentTime;
  waveBus.gain.cancelScheduledValues(now);
  waveBus.gain.setValueAtTime(waveBus.gain.value, now);
  waveBus.gain.linearRampToValueAtTime(0, now + 1.0);
  setTimeout(() => {
    try { brown.stop(); white.stop(); lfo.stop(); } catch (e) {}
    waveNodes = null;
  }, 1100);
}

// Duck = smoothly fade the wave bus to silence without tearing down the nodes,
// so it can swell back when the user resumes.
function duckSound() {
  if (!waveNodes) return;
  const now = audioCtx.currentTime;
  const bus = waveNodes.waveBus;
  bus.gain.cancelScheduledValues(now);
  bus.gain.setValueAtTime(bus.gain.value, now);
  bus.gain.linearRampToValueAtTime(0, now + 1.2);
}

function unduckSound() {
  if (!waveNodes) return;
  const now = audioCtx.currentTime;
  const bus = waveNodes.waveBus;
  bus.gain.cancelScheduledValues(now);
  bus.gain.setValueAtTime(bus.gain.value, now);
  bus.gain.linearRampToValueAtTime(1.0, now + 1.5);
}

function setVolume(pct) {
  volValue.textContent = pct;
  if (!masterGain) return;
  masterGain.gain.setTargetAtTime(pct / 100 * 0.6, audioCtx.currentTime, 0.05);
}

function toggleSound() {
  if (soundOn) {
    stopOceanWaves();
    soundOn = false;
    soundLinkedToTimer = false;
    soundToggle.classList.remove('active');
  } else {
    startOceanWaves();
    soundOn = true;
    // Linked if the timer is currently running; independent if toggled while idle.
    soundLinkedToTimer = state.running;
    soundToggle.classList.add('active');
  }
}

// ---------- Chime (gentle bell on phase complete) ----------
function playChime() {
  ensureAudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const now = audioCtx.currentTime;
  // Two soft sine tones a fifth apart, gently decaying
  const tones = [528, 792]; // pleasing interval
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

// ---------- Event listeners ----------
startBtn.addEventListener('click', () => {
  toggleStart();
  requestNotificationPermission();
});

resetBtn.addEventListener('click', reset);
skipBtn.addEventListener('click', skip);

soundToggle.addEventListener('click', toggleSound);

volumeSlider.addEventListener('input', (e) => {
  setVolume(parseInt(e.target.value, 10));
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

// Spacebar to start/pause
document.addEventListener('keydown', (e) => {
  // Don't hijack typing in inputs
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
animateWave();
volValue.textContent = volumeSlider.value;
