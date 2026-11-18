'use strict';

const STORAGE_KEY = 'todometro:v1';
const LEGACY_STORAGE_KEY = 'pomodoro:v1';
const HISTORY_LIMIT = 5;
const DEFAULT_DURATION_MS = 5 * 60 * 1000;
const MAX_DURATION_MS = 99 * 60 * 1000 + 59 * 1000;
const RING_CIRCUMFERENCE = 2 * Math.PI * 94;

const $ = (id) => document.getElementById(id);

const els = {
  dial: $('dial'),
  dialProgress: $('dialProgress'),
  timeDisplay: $('timeDisplay'),
  timeMain: $('timeMain'),
  timeMs: $('timeMs'),
  durationInputs: $('durationInputs'),
  inputMin: $('inputMin'),
  inputSec: $('inputSec'),
  btnToggle: $('btnToggle'),
  btnReset: $('btnReset'),
  btnLap: $('btnLap'),
  marksPanel: $('marksPanel'),
  marksList: $('marksList'),
  marksEmpty: $('marksEmpty'),
  modeStopwatch: $('modeStopwatch'),
  modeCountdown: $('modeCountdown'),
  btnHistory: $('btnHistory'),
  btnPin: $('btnPin'),
  btnMin: $('btnMin'),
  btnClose: $('btnClose'),
  overlay: $('historyOverlay'),
  btnHistoryClose: $('btnHistoryClose'),
  historyStopwatch: $('historyStopwatch'),
  historyCountdown: $('historyCountdown'),
};

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

function toFiniteNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_DURATION_MS;
  const rounded = Math.round(ms / 1000) * 1000;
  return Math.min(MAX_DURATION_MS, Math.max(1000, rounded));
}

function splitStopwatch(ms) {
  const total = Math.max(0, Math.floor(ms));
  return {
    hours: Math.floor(total / 3600000),
    minutes: Math.floor(total / 60000) % 60,
    seconds: Math.floor(total / 1000) % 60,
    millis: total % 1000,
  };
}

function formatStopwatch(ms) {
  const time = splitStopwatch(ms);
  return `${pad(time.hours)}:${pad(time.minutes)}:${pad(time.seconds)}.${pad(time.millis, 3)}`;
}

function formatMMSS(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(totalSeconds / 60))}:${pad(totalSeconds % 60)}`;
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  return `${pad(Math.floor(totalSeconds / 60))}:${pad(totalSeconds % 60)}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

function formatLocalDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Fecha desconocida';
  return date.toLocaleString();
}

function sanitizeStopwatchHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const totalMs = toFiniteNumber(entry.totalMs);
      if (totalMs === null || totalMs < 0) return null;
      const finishedAt = typeof entry.finishedAt === 'string' ? entry.finishedAt : '';
      const flags = Array.isArray(entry.flags)
        ? entry.flags
            .map(toFiniteNumber)
            .filter((flag) => flag !== null && flag >= 0)
            .map((flag) => Math.round(flag))
        : [];
      return { finishedAt, totalMs: Math.round(totalMs), flags };
    })
    .filter(Boolean)
    .slice(0, HISTORY_LIMIT);
}

function sanitizeCountdownHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const durationMs = toFiniteNumber(entry.durationMs);
      const totalMs = toFiniteNumber(entry.totalMs);
      if (durationMs === null || durationMs <= 0) return null;
      if (totalMs === null || totalMs < 0) return null;
      const finishedAt = typeof entry.finishedAt === 'string' ? entry.finishedAt : '';
      const laps = Array.isArray(entry.laps)
        ? entry.laps
            .map((lap, index) => {
              if (!lap || typeof lap !== 'object') return null;
              const lapMs = toFiniteNumber(lap.lapMs);
              const atMs = toFiniteNumber(lap.atMs);
              if (lapMs === null || lapMs < 0 || atMs === null || atMs < 0) return null;
              const n = Number.isInteger(lap.n) && lap.n > 0 ? lap.n : index + 1;
              return { n, lapMs: Math.round(lapMs), atMs: Math.round(atMs) };
            })
            .filter(Boolean)
        : [];
      return {
        finishedAt,
        durationMs: Math.round(durationMs),
        totalMs: Math.round(totalMs),
        laps,
      };
    })
    .filter(Boolean)
    .slice(0, HISTORY_LIMIT);
}

function defaultState() {
  return {
    mode: 'stopwatch',
    countdownDurationMs: DEFAULT_DURATION_MS,
    stopwatchHistory: [],
    countdownHistory: [],
  };
}

function loadState() {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return defaultState();
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return defaultState();
    const duration = toFiniteNumber(data.countdownDurationMs);
    return {
      mode: data.mode === 'countdown' ? 'countdown' : 'stopwatch',
      countdownDurationMs: clampDuration(duration === null ? DEFAULT_DURATION_MS : duration),
      stopwatchHistory: sanitizeStopwatchHistory(data.stopwatchHistory),
      countdownHistory: sanitizeCountdownHistory(data.countdownHistory),
    };
  } catch {
    return defaultState();
  }
}

let state = loadState();

const stopwatch = {
  running: false,
  epoch: 0,
  elapsed: 0,
  flags: [],
  rafId: 0,
};

const countdown = {
  running: false,
  started: false,
  finished: false,
  duration: state.countdownDurationMs,
  remaining: state.countdownDurationMs,
  endTime: 0,
  laps: [],
  archived: false,
  rafId: 0,
};

let lastFocusedElement = null;
let pinned = true;
let appWindow = null;

function saveState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        mode: state.mode,
        countdownDurationMs: state.countdownDurationMs,
        stopwatchHistory: state.stopwatchHistory,
        countdownHistory: state.countdownHistory,
      })
    );
  } catch {
    void 0;
  }
}

function truncateHistory(history) {
  return history.slice(0, HISTORY_LIMIT);
}

function setRing(fraction) {
  const clamped = Math.min(1, Math.max(0, fraction));
  els.dialProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - clamped));
}

function stopwatchElapsedNow() {
  return stopwatch.running ? Math.max(0, performance.now() - stopwatch.epoch) : stopwatch.elapsed;
}

function countdownRemainingNow() {
  if (!countdown.running) return Math.max(0, countdown.remaining);
  return Math.max(0, countdown.endTime - performance.now());
}

function scheduleStopwatchFrame() {
  if (stopwatch.rafId) return;
  stopwatch.rafId = requestAnimationFrame(stepStopwatch);
}

function cancelStopwatchFrame() {
  if (!stopwatch.rafId) return;
  cancelAnimationFrame(stopwatch.rafId);
  stopwatch.rafId = 0;
}

function stepStopwatch() {
  stopwatch.rafId = 0;
  if (!stopwatch.running) return;
  if (state.mode === 'stopwatch') renderStopwatch();
  scheduleStopwatchFrame();
}

function scheduleCountdownFrame() {
  if (countdown.rafId) return;
  countdown.rafId = requestAnimationFrame(stepCountdown);
}

function cancelCountdownFrame() {
  if (!countdown.rafId) return;
  cancelAnimationFrame(countdown.rafId);
  countdown.rafId = 0;
}

function stepCountdown() {
  countdown.rafId = 0;
  if (!countdown.running) return;
  if (countdownRemainingNow() <= 0) {
    finishCountdown();
    return;
  }
  if (state.mode === 'countdown') renderCountdown();
  scheduleCountdownFrame();
}

function updateToggleButton() {
  const isStopwatch = state.mode === 'stopwatch';
  const running = isStopwatch ? stopwatch.running : countdown.running;
  let label;
  if (running) {
    label = 'Pausar';
  } else if (isStopwatch) {
    label = stopwatchElapsedNow() > 0 ? 'Reanudar' : 'Iniciar';
  } else if (countdown.finished) {
    label = 'Iniciar de nuevo';
  } else if (countdown.started) {
    label = 'Reanudar';
  } else {
    label = 'Iniciar';
  }
  if (els.btnToggle.dataset.label !== label) {
    els.btnToggle.dataset.label = label;
    els.btnToggle.setAttribute('aria-label', label);
    els.btnToggle.title = label;
  }
  els.btnToggle.classList.toggle('is-running', running);
}

function updateLapButton() {
  const isStopwatch = state.mode === 'stopwatch';
  const label = isStopwatch ? 'Añadir bandera' : 'Añadir lap';
  if (els.btnLap.dataset.label !== label) {
    els.btnLap.dataset.label = label;
    els.btnLap.setAttribute('aria-label', label);
    els.btnLap.title = label;
  }
  els.btnLap.disabled = isStopwatch ? stopwatchElapsedNow() <= 0 : !countdown.running;
}

function renderStopwatch() {
  const elapsed = stopwatchElapsedNow();
  const time = splitStopwatch(elapsed);
  els.timeMain.textContent = `${pad(time.hours)}:${pad(time.minutes)}:${pad(time.seconds)}`;
  els.timeMs.textContent = `.${pad(time.millis, 3)}`;
  els.timeDisplay.classList.remove('countdown');
  els.timeDisplay.hidden = false;
  els.durationInputs.hidden = true;
  els.dial.classList.remove('finished');
  setRing((elapsed % 60000) / 60000);
  updateToggleButton();
  updateLapButton();
}

function renderCountdown() {
  const showInputs = !countdown.started;
  els.timeDisplay.classList.add('countdown');
  els.timeDisplay.hidden = showInputs;
  els.durationInputs.hidden = !showInputs;
  els.dial.classList.toggle('finished', countdown.finished);

  if (showInputs) {
    setRing(1);
  } else if (countdown.finished) {
    els.timeMain.textContent = '00:00';
    setRing(1);
  } else {
    const remaining = countdownRemainingNow();
    els.timeMain.textContent = formatCountdown(remaining);
    setRing(countdown.duration > 0 ? remaining / countdown.duration : 0);
  }

  updateToggleButton();
  updateLapButton();
}

function renderMarks() {
  const isStopwatch = state.mode === 'stopwatch';
  const marks = isStopwatch
    ? stopwatch.flags.map((ms, index) => ({ n: index + 1, time: formatStopwatch(ms) }))
    : countdown.laps.map((lap) => ({ n: lap.n, time: formatMMSS(lap.lapMs) }));

  els.marksList.textContent = '';
  const fragment = document.createDocumentFragment();
  for (const mark of marks) {
    const li = document.createElement('li');
    const number = document.createElement('span');
    number.className = 'mark-n';
    number.textContent = `#${mark.n}`;
    const value = document.createElement('span');
    value.className = 'mark-time';
    value.textContent = mark.time;
    li.append(number, value);
    fragment.appendChild(li);
  }
  els.marksList.appendChild(fragment);
  els.marksList.hidden = marks.length === 0;
  els.marksEmpty.hidden = marks.length > 0;
  els.marksEmpty.textContent = isStopwatch ? 'Sin banderas' : 'Sin laps';
  els.marksPanel.setAttribute('aria-label', isStopwatch ? 'Banderas de la sesión' : 'Laps de la sesión');
}

function scrollMarks() {
  els.marksPanel.scrollTop = els.marksPanel.scrollHeight;
}

function archiveStopwatch(totalMs) {
  const total = Math.max(0, Math.round(totalMs));
  if (total <= 0) return;
  state.stopwatchHistory.unshift({
    finishedAt: new Date().toISOString(),
    totalMs: total,
    flags: stopwatch.flags.slice(),
  });
  state.stopwatchHistory = truncateHistory(state.stopwatchHistory);
  saveState();
  renderHistory();
}

function archiveCountdown(totalMs) {
  if (countdown.archived) return;
  const total = Math.max(0, Math.round(totalMs));
  if (total <= 0) return;
  countdown.archived = true;
  state.countdownHistory.unshift({
    finishedAt: new Date().toISOString(),
    durationMs: countdown.duration,
    totalMs: total,
    laps: countdown.laps.map((lap) => ({ n: lap.n, lapMs: lap.lapMs, atMs: lap.atMs })),
  });
  state.countdownHistory = truncateHistory(state.countdownHistory);
  saveState();
  renderHistory();
}

function toggleStopwatch() {
  if (stopwatch.running) {
    stopwatch.elapsed = stopwatchElapsedNow();
    stopwatch.running = false;
    cancelStopwatchFrame();
  } else {
    stopwatch.epoch = performance.now() - stopwatch.elapsed;
    stopwatch.running = true;
    scheduleStopwatchFrame();
  }
  renderStopwatch();
}

function resetStopwatch() {
  const elapsed = stopwatchElapsedNow();
  stopwatch.running = false;
  cancelStopwatchFrame();
  if (elapsed > 0) archiveStopwatch(elapsed);
  stopwatch.elapsed = 0;
  stopwatch.flags = [];
  renderStopwatch();
  renderMarks();
}

function addStopwatchFlag() {
  const elapsed = Math.max(0, Math.floor(stopwatchElapsedNow()));
  if (elapsed <= 0) return;
  stopwatch.flags.push(elapsed);
  renderMarks();
  scrollMarks();
  updateLapButton();
}

function setDurationInputsFromMs(ms) {
  const minutes = Math.min(99, Math.floor(ms / 60000));
  const seconds = Math.floor(ms / 1000) % 60;
  els.inputMin.value = pad(minutes);
  els.inputSec.value = pad(seconds);
}

function parseDurationInputs() {
  const rawMinutes = Math.floor(Number(els.inputMin.value));
  const rawSeconds = Math.floor(Number(els.inputSec.value));
  const minutes = Number.isFinite(rawMinutes) ? Math.min(99, Math.max(0, rawMinutes)) : 0;
  const seconds = Number.isFinite(rawSeconds) ? Math.min(59, Math.max(0, rawSeconds)) : 0;
  return { minutes, seconds, totalMs: minutes * 60000 + seconds * 1000 };
}

function clearDurationInvalid() {
  els.durationInputs.classList.remove('invalid');
  els.inputMin.removeAttribute('aria-invalid');
  els.inputSec.removeAttribute('aria-invalid');
}

function markDurationInvalid() {
  els.durationInputs.classList.add('invalid');
  els.inputMin.setAttribute('aria-invalid', 'true');
  els.inputSec.setAttribute('aria-invalid', 'true');
  els.inputMin.focus();
  els.inputMin.select();
}

function handleDurationChange() {
  if (countdown.started) return;
  const { totalMs } = parseDurationInputs();
  if (totalMs <= 0) {
    renderCountdown();
    return;
  }
  countdown.duration = totalMs;
  countdown.remaining = totalMs;
  state.countdownDurationMs = totalMs;
  clearDurationInvalid();
  saveState();
  renderCountdown();
}

function normalizeDurationInputs() {
  const { minutes, seconds } = parseDurationInputs();
  els.inputMin.value = pad(minutes);
  els.inputSec.value = pad(seconds);
}

function startCountdownSession(durationMs) {
  countdown.duration = durationMs;
  countdown.remaining = durationMs;
  countdown.laps = [];
  countdown.archived = false;
  countdown.finished = false;
  countdown.started = true;
  countdown.endTime = performance.now() + durationMs;
  countdown.running = true;
  clearDurationInvalid();
  scheduleCountdownFrame();
  renderCountdown();
  renderMarks();
}

function toggleCountdown() {
  if (countdown.running) {
    countdown.remaining = countdownRemainingNow();
    countdown.running = false;
    cancelCountdownFrame();
    if (countdown.remaining <= 0) {
      finishCountdown();
      return;
    }
    renderCountdown();
    return;
  }

  if (countdown.finished || countdown.remaining <= 0) {
    startCountdownSession(state.countdownDurationMs);
    return;
  }

  if (!countdown.started) {
    const { totalMs } = parseDurationInputs();
    if (totalMs <= 0) {
      markDurationInvalid();
      return;
    }
    state.countdownDurationMs = totalMs;
    saveState();
    startCountdownSession(totalMs);
    return;
  }

  countdown.endTime = performance.now() + countdown.remaining;
  countdown.running = true;
  scheduleCountdownFrame();
  renderCountdown();
}

function finishCountdown() {
  countdown.running = false;
  cancelCountdownFrame();
  countdown.remaining = 0;
  countdown.started = true;
  countdown.finished = true;
  const lapsTotal = countdown.laps.reduce((sum, lap) => sum + lap.lapMs, 0);
  archiveCountdown(lapsTotal + countdown.duration);
  if (state.mode === 'countdown') {
    renderCountdown();
    els.dial.classList.remove('finished');
    void els.dial.offsetWidth;
    els.dial.classList.add('finished');
  }
  updateToggleButton();
  updateLapButton();
}

function resetCountdown() {
  const consumed = countdown.started
    ? Math.max(0, countdown.duration - countdownRemainingNow())
    : 0;
  const lapsTotal = countdown.laps.reduce((sum, lap) => sum + lap.lapMs, 0);
  const totalMs = lapsTotal + consumed;
  if (countdown.started && totalMs > 0) archiveCountdown(totalMs);

  countdown.running = false;
  countdown.started = false;
  countdown.finished = false;
  countdown.duration = state.countdownDurationMs;
  countdown.remaining = countdown.duration;
  countdown.endTime = 0;
  countdown.laps = [];
  countdown.archived = false;
  cancelCountdownFrame();
  els.dial.classList.remove('finished');
  setDurationInputsFromMs(countdown.duration);
  clearDurationInvalid();
  renderCountdown();
  renderMarks();
}

function addCountdownLap() {
  if (!countdown.running) return;
  const now = performance.now();
  const remaining = Math.max(0, countdown.endTime - now);
  const lapMs = Math.max(0, Math.round(countdown.duration - remaining));
  const previousTotal = countdown.laps.reduce((sum, lap) => sum + lap.lapMs, 0);
  countdown.laps.push({
    n: countdown.laps.length + 1,
    lapMs,
    atMs: previousTotal + lapMs,
  });
  countdown.endTime = now + countdown.duration;
  renderMarks();
  scrollMarks();
  renderCountdown();
}

function toggleActiveMode() {
  if (state.mode === 'stopwatch') toggleStopwatch();
  else toggleCountdown();
}

function resetActiveMode() {
  if (state.mode === 'stopwatch') resetStopwatch();
  else resetCountdown();
}

function addActiveMark() {
  if (state.mode === 'stopwatch') addStopwatchFlag();
  else addCountdownLap();
}

function setMode(mode, options = {}) {
  if (mode !== 'stopwatch' && mode !== 'countdown') return;
  const persist = options.persist !== false;
  state.mode = mode;
  if (persist) saveState();

  const isStopwatch = mode === 'stopwatch';
  document.body.dataset.mode = mode;
  els.modeStopwatch.classList.toggle('active', isStopwatch);
  els.modeCountdown.classList.toggle('active', !isStopwatch);
  els.modeStopwatch.setAttribute('aria-pressed', String(isStopwatch));
  els.modeCountdown.setAttribute('aria-pressed', String(!isStopwatch));
  els.timeDisplay.classList.toggle('countdown', !isStopwatch);
  renderMarks();

  if (isStopwatch) renderStopwatch();
  else renderCountdown();
}

function createHistoryEmpty(text) {
  const empty = document.createElement('p');
  empty.className = 'history-section-empty';
  empty.textContent = text;
  return empty;
}

function renderStopwatchHistory() {
  const container = els.historyStopwatch;
  container.textContent = '';
  if (state.stopwatchHistory.length === 0) {
    container.appendChild(createHistoryEmpty('Sin sesiones'));
    return;
  }

  for (const entry of state.stopwatchHistory) {
    const details = document.createElement('details');
    details.className = 'history-item';

    const summary = document.createElement('summary');
    const date = document.createElement('span');
    date.className = 'history-date';
    date.textContent = formatLocalDate(entry.finishedAt);
    const total = document.createElement('span');
    total.className = 'history-total';
    total.textContent = formatStopwatch(entry.totalMs);
    summary.append(date, total);

    const body = document.createElement('div');
    body.className = 'history-detail';
    if (entry.flags.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = 'Sin banderas';
      body.appendChild(empty);
    } else {
      const sub = document.createElement('div');
      sub.className = 'history-sub';
      sub.textContent = entry.flags.length === 1 ? '1 bandera' : `${entry.flags.length} banderas`;
      const list = document.createElement('ol');
      list.className = 'history-laps';
      entry.flags.forEach((ms, index) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = `Bandera ${index + 1}`;
        const value = document.createElement('span');
        value.textContent = formatStopwatch(ms);
        li.append(name, value);
        list.appendChild(li);
      });
      body.append(sub, list);
    }

    details.append(summary, body);
    container.appendChild(details);
  }
}

function renderCountdownHistory() {
  const container = els.historyCountdown;
  container.textContent = '';
  if (state.countdownHistory.length === 0) {
    container.appendChild(createHistoryEmpty('Sin sesiones'));
    return;
  }

  for (const entry of state.countdownHistory) {
    const details = document.createElement('details');
    details.className = 'history-item';

    const summary = document.createElement('summary');
    const date = document.createElement('span');
    date.className = 'history-date';
    date.textContent = formatLocalDate(entry.finishedAt);
    const total = document.createElement('span');
    total.className = 'history-total';
    total.textContent = formatDuration(entry.totalMs);
    summary.append(date, total);

    const body = document.createElement('div');
    body.className = 'history-detail';
    const sub = document.createElement('div');
    sub.className = 'history-sub';
    sub.textContent = `Duración: ${formatDuration(entry.durationMs)}`;
    body.appendChild(sub);

    if (entry.laps.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = 'Sin laps';
      body.appendChild(empty);
    } else {
      const list = document.createElement('ol');
      list.className = 'history-laps';
      for (const lap of entry.laps) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = `Lap ${lap.n}`;
        const value = document.createElement('span');
        value.textContent = formatMMSS(lap.lapMs);
        li.append(name, value);
        list.appendChild(li);
      }
      body.appendChild(list);
    }

    details.append(summary, body);
    container.appendChild(details);
  }
}

function renderHistory() {
  renderStopwatchHistory();
  renderCountdownHistory();
}

function openHistory() {
  if (!els.overlay.hidden) return;
  lastFocusedElement = document.activeElement;
  renderHistory();
  els.overlay.hidden = false;
  els.overlay.setAttribute('aria-hidden', 'false');
  els.btnHistoryClose.focus();
}

function closeHistory() {
  if (els.overlay.hidden) return;
  els.overlay.hidden = true;
  els.overlay.setAttribute('aria-hidden', 'true');
  if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
    lastFocusedElement.focus();
  }
}

function setPinState(value) {
  pinned = Boolean(value);
  els.btnPin.classList.toggle('active', pinned);
  els.btnPin.setAttribute('aria-pressed', String(pinned));
  els.btnPin.setAttribute('aria-label', pinned ? 'Desanclar ventana' : 'Fijar siempre visible');
  els.btnPin.title = pinned ? 'Siempre visible' : 'No siempre visible';
}

function setupWindowControls() {
  const tauri = window.__TAURI__;
  appWindow =
    tauri && tauri.window && typeof tauri.window.getCurrentWindow === 'function'
      ? tauri.window.getCurrentWindow()
      : null;

  setPinState(true);
  if (appWindow) {
    appWindow
      .isAlwaysOnTop()
      .then(setPinState)
      .catch(() => setPinState(true));
  }

  els.btnPin.addEventListener('click', async () => {
    const next = !pinned;
    if (appWindow) {
      try {
        await appWindow.setAlwaysOnTop(next);
        const actual = await appWindow.isAlwaysOnTop().catch(() => next);
        setPinState(actual);
        return;
      } catch {
        void 0;
      }
    }
    setPinState(next);
  });

  els.btnMin.addEventListener('click', () => {
    if (appWindow) {
      appWindow.minimize().catch(() => {});
    }
  });

  els.btnClose.addEventListener('click', () => {
    if (appWindow) {
      appWindow.close().catch(() => {});
    } else {
      window.close();
    }
  });
}

function setupResizeHandles() {
  const handles = document.querySelectorAll('[data-resize]');
  for (const handle of handles) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !appWindow) return;
      event.preventDefault();
      appWindow.startResizeDragging(handle.dataset.resize).catch(() => {});
    });
  }
}

function isTextEntryTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function setupEvents() {
  els.modeStopwatch.addEventListener('click', () => setMode('stopwatch'));
  els.modeCountdown.addEventListener('click', () => setMode('countdown'));
  els.btnToggle.addEventListener('click', toggleActiveMode);
  els.btnReset.addEventListener('click', resetActiveMode);
  els.btnLap.addEventListener('click', addActiveMark);
  els.btnHistory.addEventListener('click', openHistory);
  els.btnHistoryClose.addEventListener('click', closeHistory);

  els.inputMin.addEventListener('input', handleDurationChange);
  els.inputSec.addEventListener('input', handleDurationChange);
  els.inputMin.addEventListener('blur', () => {
    normalizeDurationInputs();
    handleDurationChange();
  });
  els.inputSec.addEventListener('blur', () => {
    normalizeDurationInputs();
    handleDurationChange();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!els.overlay.hidden) {
        event.preventDefault();
        closeHistory();
      }
      return;
    }
    if (!els.overlay.hidden) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.isComposing) return;
    if (isTextEntryTarget(event.target)) return;
    if (event.repeat) return;

    if (event.code === 'Space') {
      event.preventDefault();
      toggleActiveMode();
    } else if (event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      addActiveMark();
    } else if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      resetActiveMode();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (state.mode === 'stopwatch') renderStopwatch();
    else renderCountdown();
  });
}

function init() {
  els.dialProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  els.dialProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  els.overlay.setAttribute('aria-hidden', 'true');
  setDurationInputsFromMs(state.countdownDurationMs);
  countdown.duration = state.countdownDurationMs;
  countdown.remaining = state.countdownDurationMs;
  setupWindowControls();
  setupResizeHandles();
  setupEvents();
  setMode(state.mode, { persist: false });
  renderHistory();
}

init();
