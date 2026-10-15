/* Additional calibration links; never touches RTC.send or the gameplay peer. */
(function () {
  'use strict';

  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const number = v => typeof v === 'number' ? v
    : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  const range = (v, min, max) => Number.isFinite(number(v)) && number(v) >= min && number(v) <= max;

  function values(raw) {
    if (!object(raw) || !Object.keys(raw).length) return null;
    const result = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!Object.hasOwn(window.CONFIG_DEFAULTS, key)) return null;
      if (['teamA', 'teamB'].includes(key)) {
        if (typeof value !== 'string' || !Object.hasOwn(window.TEAM_INDICES, value)) return null;
        result[key] = value;
      } else if (['domThr', 'satMin', 'yMin', 'yMax', 'COLOR_TABLE'].includes(key)) {
        const length = key === 'COLOR_TABLE' ? 24 : 4;
        if (!Array.isArray(value) || value.length !== length || !value.every(v => range(v, 0, 1))) return null;
        result[key] = value.map(number);
      } else if (['topRect', 'frontRect'].includes(key)) {
        if (!object(value) || Object.keys(value).sort().join(',') !== 'h,w,x,y'
          || !range(value.x, 0, 8192) || !range(value.y, 0, 8192)
          || !range(value.w, 1, 8192) || !range(value.h, 1, 8192)) return null;
        result[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, number(v)]));
      } else if (key === 'url') {
        if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//i.test(value)) return null;
        try { new URL(value); } catch { return null; }
        result[key] = value;
      } else {
        const bounds = {
          camW: [2, 8192], camH: [2, 8192], zoom: [1, 64],
          topMinArea: [0, 1], frontMinArea: [0, 67108864], radiusPx: [0, 4096],
          topH: [1, 8192], frontH: [1, 8192], topMode: [0, 1]
        }[key];
        if (!bounds || !range(value, ...bounds)) return null;
        if (['camW', 'camH', 'topMode'].includes(key) && !Number.isInteger(number(value))) return null;
        result[key] = number(value);
      }
    }
    return result;
  }

  function decode(text, type) {
    if (typeof text !== 'string' || text.length > 16384) return null;
    try {
      const message = JSON.parse(text);
      if (!object(message) || Object.keys(message).sort().join(',') !== 'type,values' || message.type !== type) return null;
      return values(message.values);
    } catch { return null; }
  }

  function room(source) {
    if (!['top', 'front'].includes(source)) throw new Error('Invalid calibration source');
    return window.RTC.rooms[source];
  }

  const connectionStates = { game: 'new', calibration: 'new' };
  function renderStatus() {
    if (typeof document.getElementById !== 'function') return;
    const el = document.getElementById('state');
    if (el) el.textContent = `Game: ${connectionStates.game} | Calibration: ${connectionStates.calibration}`;
  }
  function setStatus(kind, state, detail = '') {
    connectionStates[kind] = detail ? `${state} (${detail})` : state;
    renderStatus();
  }
  function controls() {
    if (window.CalibrationPreview || typeof document.getElementById !== 'function') return;
    const state = document.getElementById('state');
    if (!state) return;
    state.setAttribute('aria-live', 'polite');
    const bar = document.createElement('span');
    bar.style.cssText = 'display:inline-flex;gap:4px;margin-left:8px;pointer-events:auto';
    const isTop = location.pathname.endsWith('/top.html');
    const actions = isTop
      ? [['↻ Reset Game', 'Reset gameplay room', () => window.RTC.restart(window.RTC.rooms.gameplay)],
         ['Connect Cal', 'Connect to top calibration room', () => window.CalibrationPhone?.connect()]]
      : [['Connect Game', 'Connect to gameplay room', () => {
           const target = window.RTC.rooms.gameplay;
           if (window.RTC.getController(target)) void window.RTC.restart(target);
           else void window.RTC.startB({ room: target, onState: (state, detail) =>
             window.Calibration?.setStatus('game', state, detail) });
         }],
         ['Connect Cal', 'Connect to front calibration room', () => window.CalibrationPhone?.connect()]];
    for (const [label, aria, action] of actions) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = label; button.setAttribute('aria-label', aria);
      button.addEventListener('click', () => { void action(); });
      bar.append(button);
    }
    state.after(bar);
    renderStatus();
  }

  function apply(patch) {
    for (const [key, value] of Object.entries(patch)) window.Config.save(key, value);
    window.Setup.refresh();
  }

  const STREAM_RATES = Object.freeze([2, 5, 10, 15, 30]);
  const validStreamRate = fps => STREAM_RATES.includes(fps);
  const validTelemetry = v => object(v)
    && Object.keys(v).sort().join(',') === 'captureFps,copyMs,gameplayFps,requestedFps,sentFps'
    && validStreamRate(v.requestedFps)
    && ['captureFps', 'copyMs'].every(key => typeof v[key] === 'number' && Number.isFinite(v[key]) && v[key] >= 0 && v[key] <= 60000)
    && ['gameplayFps', 'sentFps'].every(key => v[key] === null || (typeof v[key] === 'number' && Number.isFinite(v[key]) && v[key] >= 0 && v[key] <= 1000));

  function link({ source, offerer = false, stream, onStream = () => {}, report = console.log, onState = () => {}, onRate = () => {}, onTelemetry = () => {}, onOpen = () => {} }) {
    let channel, peer, controller, stopped = false, applying = false, seeded = false;
    let sendTimer;
    const send = (type, raw) => {
      const checked = values(raw);
      if (checked && channel?.readyState === 'open') channel.send(JSON.stringify({ type, values: checked }));
    };
    const sendAux = (type, data) => {
      if (channel?.readyState !== 'open') return false;
      channel.send(JSON.stringify({ type, values: data }));
      return true;
    };
    const snapshot = () => send('calibration-state', window.Config.snapshot());
    const pending = {};
    const unsubscribe = window.Config.subscribe((key, value) => {
      if (applying) return;
      if (offerer) {
        if (!seeded) return;
        pending[key] = value;
        clearTimeout(sendTimer);
        sendTimer = setTimeout(() => {
          send('calibration-config', pending);
          for (const k of Object.keys(pending)) delete pending[k];
        }, 0);
      } else {
        clearTimeout(sendTimer);
        sendTimer = setTimeout(snapshot, 0);
      }
    });
    const options = {
      room: room(source), log: report,
      preparePc(pc) {
        peer = pc;
        if (stopped) { pc.close(); throw new Error('Calibration stopped'); }
        if (offerer) pc.addTransceiver('video', { direction: 'recvonly' });
        else for (const track of stream.getVideoTracks()) pc.addTrack(track, stream);
      },
      onTrack: e => onStream(e.streams[0] || new MediaStream([e.track])),
      onState(state, detail) {
        if (state === 'signaling' || state === 'negotiating') seeded = false;
        report(detail ? `${state}: ${detail}` : state);
        if (!offerer) setStatus('calibration', state, detail);
        onState(seeded && state === 'connected' ? 'ready' : state);
      },
      onOpen(ch) {
        channel = ch;
        report('connected');
        if (!offerer) snapshot();
        onOpen();
      },
      onMessage(text) {
        let message;
        try { message = JSON.parse(text); } catch (_) { /* Existing decoder handles bad JSON. */ }
        if (!offerer && message?.type === 'calibration-rate') {
          if (object(message.values) && Object.keys(message.values).join(',') === 'fps'
            && validStreamRate(message.values.fps)) onRate(message.values.fps);
          else report('Rejected invalid calibration FPS');
          return;
        }
        if (offerer && message?.type === 'calibration-telemetry') {
          if (validTelemetry(message.values)) onTelemetry(message.values);
          else report('Rejected invalid calibration telemetry');
          return;
        }
        const patch = decode(text, offerer ? 'calibration-state' : 'calibration-config');
        if (!patch) { report('Rejected invalid calibration payload'); return; }
        applying = true;
        try {
          apply(patch);
          if (offerer) {
            // Preview Config is memory-only to keep the two panes independent.
            // Persist the authoritative phone state explicitly, including after
            // reconnect; never hydrate a pane from another phone's shared keys.
            for (const [key, value] of Object.entries(patch)) localStorage.setItem(key, JSON.stringify(value));
            seeded = true;
            onState('ready');
          }
        } catch (err) { report(err.message); }
        finally { applying = false; }
        if (!offerer) snapshot();
      }
    };
    async function start() {
      if (stopped) return;
      try {
        controller = await (offerer ? window.RTC.startA(options) : window.RTC.startB(options));
        if (stopped) controller?.stop();
      } catch (error) { report(error.message); }
    }
    // Only the calibration workstation offers and resets automatically.
    if (offerer) void start();
    const stop = () => {
      stopped = true;
      clearTimeout(sendTimer);
      unsubscribe();
      controller?.stop();
      channel?.close();
      peer?.close();
    };
    window.addEventListener('pagehide', stop, { once: true });
    return {
      stop,
      connect() {
        if (stopped) return;
        const existing = window.RTC.getController(room(source));
        if (existing) void existing.restart(); // responder rejoins without resetting
        else void start();
      },
      setRate(fps) { return offerer && validStreamRate(fps) && sendAux('calibration-rate', { fps }); },
      sendTelemetry(data) { return !offerer && validTelemetry(data) && sendAux('calibration-telemetry', data); }
    };
  }

  function phone(source) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    const ctx = canvas.getContext('2d');
    // Manual capture: the calibration connection chooses its own cadence.
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    if (!track.requestFrame) { track.stop(); throw new Error('Manual canvas capture is not supported'); }
    let stopped = false, timer = null, rate = 2;
    let copied = 0, totalCopyMs = 0, lastMetrics = performance.now();
    let lastOutbound = null, reporting = false;
    const report = text => { if (window.CalibrationPreview) window.CalibrationPreview.report(`Calibration ${source}: ${text}`); };
    const connection = link({
      source, stream, report,
      onRate(nextRate) {
        rate = nextRate;
        // Apply rate changes immediately if waiting for the next frame.
        if (timer !== null) {
          clearTimeout(timer);
          timer = setTimeout(copy, 0);
        }
      }
    });
    window.CalibrationPhone = { connect: () => connection.connect() };

    async function sendMetrics(now) {
      if (reporting) return;
      reporting = true;
      const elapsed = Math.max(1, now - lastMetrics);
      const captureFps = copied * 1000 / elapsed;
      const copyMs = copied ? totalCopyMs / copied : 0;
      copied = 0;
      totalCopyMs = 0;
      lastMetrics = now;
      let sentFps = null;
      try {
        const pc = window.RTC.getController(window.RTC.rooms[source])?.pc;
        if (pc) {
          const reports = await pc.getStats();
          const outbound = Array.from(reports.values()).find(r =>
            r.type === 'outbound-rtp' && (r.kind === 'video' || r.mediaType === 'video'));
          if (outbound && Number.isFinite(outbound.framesSent)) {
            if (lastOutbound && lastOutbound.id === outbound.id && outbound.framesSent >= lastOutbound.frames) {
              const seconds = (outbound.timestamp - lastOutbound.timestamp) / 1000;
              if (seconds > 0) sentFps = (outbound.framesSent - lastOutbound.frames) / seconds;
            }
            lastOutbound = { id: outbound.id, frames: outbound.framesSent, timestamp: outbound.timestamp };
          } else lastOutbound = null;
        } else lastOutbound = null;
      } catch (_) { lastOutbound = null; }
      if (!stopped) connection.sendTelemetry({
        requestedFps: rate, captureFps, copyMs, sentFps,
        gameplayFps: Number.isFinite(window.TopCaptureMetrics?.fps) ? window.TopCaptureMetrics.fps : null
      });
      reporting = false;
    }

    async function copy() {
      timer = null;
      if (stopped) return;
      let frame;
      const started = performance.now();
      try {
        frame = await window.Feeds.captureFrontCalibrationFrame({ timeoutMs: 500 });
        if (stopped) return;
        if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
        if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
        ctx.drawImage(frame, 0, 0);
        track.requestFrame();
        copied++;
        totalCopyMs += performance.now() - started;
      } catch (_) { /* Camera may not have been started yet; gameplay owns acquisition. */ }
      finally {
        frame?.close();
        if (!stopped) {
          const now = performance.now();
          if (now - lastMetrics >= 2000) void sendMetrics(now);
          timer = setTimeout(copy, Math.max(0, 1000 / rate - (now - started)));
        }
      }
    }
    void copy();
    window.addEventListener('pagehide', () => {
      stopped = true;
      clearTimeout(timer);
      connection.stop();
      track.stop();
    }, { once: true });
  }

  window.Calibration = { values, decode, room, link, setStatus };
  if (!window.CalibrationPreview) {
    controls();
    try { phone(location.pathname.endsWith('/top.html') ? 'top' : 'front'); }
    catch (err) { console.error('Calibration unavailable:', err); }
  }
})();
