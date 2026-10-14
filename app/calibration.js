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

  function apply(patch) {
    for (const [key, value] of Object.entries(patch)) window.Config.save(key, value);
    window.Setup.refresh();
  }

  function link({ source, offerer = false, stream, onStream = () => {}, report = console.log, onState = () => {} }) {
    let channel, peer, controller, stopped = false, applying = false, seeded = false;
    let sendTimer;
    const send = (type, raw) => {
      const checked = values(raw);
      if (checked && channel?.readyState === 'open') channel.send(JSON.stringify({ type, values: checked }));
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
      onState(state) { report(state); onState(seeded && state === 'connected' ? 'ready' : state); },
      onOpen(ch) {
        channel = ch;
        report('connected');
        if (!offerer) snapshot();
      },
      onMessage(text) {
        const patch = decode(text, offerer ? 'calibration-state' : 'calibration-config');
        if (!patch) { report('Rejected invalid calibration payload'); return; }
        applying = true;
        try {
          apply(patch);
          if (offerer) { seeded = true; onState('ready'); }
        } catch (err) { report(err.message); }
        finally { applying = false; }
        if (!offerer) snapshot();
      }
    };
    async function start() {
      do {
        controller = await (offerer ? window.RTC.startA(options) : window.RTC.startB(options));
        if (offerer || (controller?.pc && controller.pc.connectionState !== 'closed')) break;
        if (!stopped) await new Promise(resolve => setTimeout(resolve, 1000));
      } while (!stopped);
      if (stopped) controller?.stop();
    }
    void start().catch(err => report(err.message));
    const stop = () => {
      stopped = true;
      clearTimeout(sendTimer);
      unsubscribe();
      controller?.stop();
      channel?.close();
      peer?.close();
    };
    window.addEventListener('pagehide', stop, { once: true });
    return { stop };
  }

  function phone(source) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    const ctx = canvas.getContext('2d');
    // Manual capture: at most one independent cloned frame every 500 ms (2 FPS).
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    if (!track.requestFrame) { track.stop(); throw new Error('Manual canvas capture is not supported'); }
    let stopped = false, timer;
    const status = document.createElement('p');
    status.id = 'calibrationStatus';
    status.style.cssText = 'position:fixed;bottom:0;left:0;z-index:100;color:white;background:#222;padding:4px';
    status.setAttribute('aria-live', 'polite');
    document.body.append(status);
    const report = text => { status.textContent = `Calibration ${source}: ${text}`; };
    const connection = link({ source, stream, report });
    async function copy() {
      let frame;
      try {
        frame = await window.Feeds.captureFrontCalibrationFrame({ timeoutMs: 500 });
        if (stopped) return;
        if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
        if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
        ctx.drawImage(frame, 0, 0);
        track.requestFrame();
      } catch (_) { /* Camera may not have been started yet; gameplay owns acquisition. */ }
      finally {
        frame?.close();
        if (!stopped) timer = setTimeout(copy, 500);
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

  window.Calibration = { values, decode, room, link };
  if (!window.CalibrationPreview) {
    try { phone(location.pathname.endsWith('/top.html') ? 'top' : 'front'); }
    catch (err) { console.error('Calibration unavailable:', err); }
  }
})();
