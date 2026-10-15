/*!
  WebRTC for three fixed rooms. Only offerers reset; responders explicitly join.
  Netlify signaling is used during negotiation and never polled after connection.
*/
(() => {
  const rooms = Object.freeze({ gameplay: 'default', top: 'calibration-top', front: 'calibration-front' });
  const DEFAULTS = {
    room: rooms.gameplay, base: '/.netlify/functions',
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    directOnly: false, timeoutMs: 45000, pollMs: 450
  };
  const controllers = new Map();
  const diagnosticsListeners = new Set();
  // All timestamps are elapsed milliseconds on this device, not synchronized between peers.
  const duration = value => Number.isFinite(value) ? Math.round(value) + ' ms' : '—';
  const formatDiagnostics = d => {
    if (!d) return 'No connection attempt yet';
    const offerer = d.role === 'a';
    const t = d.stages;
    return [
      `${offerer ? 'Initiator' : 'Joiner'} · ${d.status}`,
      offerer
        ? `Reset: ${duration(t.reset)} | Offer posted: ${duration(t.offerPublished)}`
        : `Offer received: ${duration(t.offerReceived)} | Answer posted: ${duration(t.answerPublished)}`,
      offerer ? `Answer received: ${duration(t.answerReceived)}` : null,
      `ICE connected: ${duration(t.iceConnected)} | Channel open: ${duration(t.channelOpen)}`,
      `Netlify: ${d.signaling.requests} calls (${d.signaling.reads} reads), total HTTP ${duration(d.signaling.totalMs)}, max ${duration(d.signaling.maxMs)}`
    ].filter(Boolean).join('\n');
  };
  const bust = url => { url.searchParams.set('_', Date.now().toString()); return url; };
  async function fetchJson(base, name, { method = 'GET', params = null, body = null } = {}) {
    const url = new URL(base + '/' + name, location.href);
    if (params) Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(bust(url), {
      method, cache: 'no-store', headers: body == null ? {} : { 'content-type': 'application/json' },
      ...(body == null ? {} : { body: JSON.stringify(body) })
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(name + ' HTTP ' + response.status);
    return (response.headers.get('content-type') || '').includes('application/json')
      ? response.json() : response.text();
  }
  const resetRoom = (base, room) => fetchJson(base, 'signal-reset', { method: 'POST', body: { room } });
  const write = (base, kind, role, data, room, generation) =>
    fetchJson(base, 'signal-write', { method: 'POST', body: { kind, role, data, room, generation } });
  const read = (base, role, room) => fetchJson(base, 'signal-read', { params: { role, room } });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const validateRoom = room => {
    if (room !== undefined && (typeof room !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(room)))
      throw new Error('Invalid room');
  };

  function createController(role, initialOptions) {
    const room = initialOptions.room || rooms.gameplay;
    const options = { ...DEFAULTS, ...initialOptions, room };
    const log = options.log || (message => {
      const el = document.getElementById('state');
      if (el) el.textContent = String(message);
      console.log(message);
    });
    let epoch = 0, current = null, stopped = false, serial = Promise.resolve();
    let diagnostics = null;
    const listeners = new Set();
    function snapshot() {
      return diagnostics && {
        room, role, status: controller.status,
        stages: { ...diagnostics.stages },
        signaling: { ...diagnostics.signaling }
      };
    }
    function notifyDiagnostics() {
      const data = snapshot();
      if (!data) return;
      for (const callback of diagnosticsListeners) {
        try { callback(data); } catch (_) {}
      }
    }
    function mark(stage) {
      if (diagnostics && diagnostics.stages[stage] == null) {
        diagnostics.stages[stage] = performance.now() - diagnostics.startedAt;
        notifyDiagnostics();
      }
    }
    async function measuredSignal(kind, fn, attempt) {
      const start = performance.now();
      try { return await fn(); }
      finally {
        if (diagnostics === attempt) {
          const elapsed = performance.now() - start;
          attempt.signaling.requests++;
          if (kind === 'read') attempt.signaling.reads++;
          attempt.signaling.totalMs += elapsed;
          attempt.signaling.maxMs = Math.max(attempt.signaling.maxMs, elapsed);
          notifyDiagnostics();
        }
      }
    }
    let resolveReady, readyDone = false;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const finishReady = () => { if (!readyDone) { readyDone = true; resolveReady(controller); } };
    const controller = {
      room, role, status: 'new', ready,
      get pc() { return current?.pc || null; },
      get channel() { return current?.channel || null; },
      get error() { return current?.error || null; },
      get diagnostics() { return snapshot(); },
      onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      send(message) {
        const channel = controller.channel;
        if (channel?.readyState !== 'open') return false;
        channel.send(message);
        return true;
      },
      stop() {
        stopped = true; epoch++;
        dispose(current); current = null;
        setStatus('stopped');
        finishReady();
      },
      restart() {
        stopped = false;
        const id = ++epoch;
        dispose(current); current = null;
        // A owns resets. B always joins the room without changing its generation.
        return enqueue(() => begin(id, role === 'a'));
      }
    };
    function setStatus(state, detail = '') {
      controller.status = state;
      log(detail ? state + ': ' + detail : state);
      notifyDiagnostics();
      try { options.onState?.(state, detail, controller); } catch (_) {}
      for (const fn of listeners) { try { fn(state, detail, controller); } catch (_) {} }
    }
    function dispose(session) {
      if (!session) return;
      session.cancelled = true;
      try {
        if (session.channel) {
          session.channel.onopen = session.channel.onmessage = session.channel.onclose = null;
          session.channel.close();
        }
      } catch (_) {}
      try { session.pc.close(); } catch (_) {}
    }
    function enqueue(fn) { serial = serial.catch(() => {}).then(fn); return serial; }

    async function begin(id, reset) {
      if (stopped || id !== epoch) return;
      const attempt = diagnostics = {
        startedAt: performance.now(),
        stages: { reset: null, offerPublished: null, offerReceived: null, answerPublished: null,
          answerReceived: null, iceConnected: null, channelOpen: null },
        signaling: { requests: 0, reads: 0, totalMs: 0, maxMs: 0 }
      };
      notifyDiagnostics();
      let generation = null;
      if (reset) {
        setStatus('signaling', 'resetting ' + room);
        try {
          const response = await measuredSignal('reset', () => resetRoom(options.base, room), attempt);
          if (!response?.generation) throw new Error('signal-reset did not return a generation');
          generation = response.generation;
          mark('reset');
        } catch (error) {
          if (id === epoch) setStatus('signaling-error', error.message);
          finishReady();
          return;
        }
      }
      if (id !== epoch || stopped) return;
      const session = {
        pc: null, channel: null, generation, cancelled: false,
        pendingCandidates: [], error: null, started: attempt.startedAt
      };
      current = session;
      const elapsed = () => Math.round(performance.now() - session.started) + ' ms';
      let pc;
      try {
        pc = session.pc = new RTCPeerConnection({
          iceServers: options.directOnly ? [] : options.iceServers || []
        });
        setStatus('negotiating', role === 'a' ? 'creating offer' : 'waiting for offer');
        const onChannel = channel => {
          session.channel = channel;
          channel.onopen = () => {
            if (current !== session || session.cancelled) return;
            mark('channelOpen');
            setStatus('connected', 'data channel open in ' + elapsed());
            finishReady();
            try { options.onOpen?.(channel, pc); } catch (error) { log(error.message); }
          };
          channel.onclose = () => {
            if (current === session && !stopped) setStatus('data-channel-error', 'channel closed; reconnect manually');
          };
          channel.onerror = () => {
            if (current === session) setStatus('data-channel-error', 'channel error');
          };
          channel.onmessage = event => {
            try {
              if (options.onMessage) options.onMessage(String(event.data), channel, pc);
              else defaultMessage(String(event.data));
            } catch (error) { log('data-channel error: ' + error.message); }
          };
        };
        pc.ondatachannel = event => onChannel(event.channel);
        if (role === 'a') onChannel(pc.createDataChannel('chat'));
        pc.onconnectionstatechange = () => {
          if (current !== session || session.cancelled) return;
          if (pc.connectionState === 'failed')
            setStatus('negotiation-error', 'peer failed; reconnect manually');
          else if (pc.connectionState === 'disconnected')
            setStatus('negotiating', 'peer disconnected; reconnect manually');
        };
        pc.oniceconnectionstatechange = () => {
          if (current !== session) return;
          if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')
            mark('iceConnected');
          else if (pc.iceConnectionState === 'failed')
            setStatus('negotiation-error', 'ICE failed; reconnect manually');
        };
        pc.onicecandidateerror = event => {
          session.error = event.errorText || String(event.errorCode || 'ICE candidate error');
          if (current === session) log('ICE diagnostic: ' + session.error);
        };
        pc.ontrack = event => {
          if (current !== session) return;
          try { options.onTrack?.(event); }
          catch (error) { session.error = error.message; setStatus('media-track-error', error.message); }
        };
        // Trickle candidates instead of holding the offer/answer until gathering completes.
        pc.onicecandidate = event => {
          if (!event.candidate || !session.generation || current !== session ||
              session.cancelled || session.channel?.readyState === 'open') return;
          const candidate = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate;
          void measuredSignal('candidate', () =>
            write(options.base, 'candidate', role, candidate, room, session.generation), attempt)
            .catch(error => { if (current === session) log('ICE candidate write: ' + error.message); });
        };
        options.preparePc?.(pc);
        if (role === 'a') {
          await pc.setLocalDescription(await pc.createOffer());
          if (id !== epoch || session.cancelled) return;
          await measuredSignal('offer', () =>
            write(options.base, 'offer', role, pc.localDescription, room, session.generation), attempt);
          mark('offerPublished');
          if (session.channel?.readyState !== 'open')
            setStatus('negotiating', 'offer sent after ' + elapsed() + '; waiting for answer');
        }
        await pollSignal(id, session, attempt);
      } catch (error) {
        if (id === epoch && !stopped) {
          session.error = error.message;
          setStatus(/signal|read|write|reset|HTTP/i.test(error.message)
            ? 'signaling-error' : 'negotiation-error', error.message);
          dispose(session);
          current = null;
        }
      } finally { finishReady(); }
    }

    async function pollSignal(id, session, attempt) {
      const pc = session.pc;
      const started = Date.now();
      let answered = false;
      async function applyCandidates() {
        if (!pc.remoteDescription) return;
        while (session.pendingCandidates.length) {
          const candidate = session.pendingCandidates.shift();
          try { await pc.addIceCandidate(candidate); }
          catch (error) { if (current === session) log('ICE candidate rejected: ' + error.message); }
        }
      }
      while (id === epoch && !stopped && !session.cancelled &&
             current === session && Date.now() - started < options.timeoutMs) {
        if (session.channel?.readyState === 'open') return;
        if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') return;
        try {
          const result = await measuredSignal('read', () => read(options.base, role, room), attempt);
          if (id !== epoch || current !== session || session.cancelled) return;
          if (result?.generation && session.generation && result.generation !== session.generation) {
            setStatus('signaling-error', 'room was reset elsewhere; press Connect or Reset manually');
            return;
          }
          if (role === 'b' && !session.generation && result?.generation)
            session.generation = result.generation;
          if (result?.candidates?.length)
            session.pendingCandidates.push(...result.candidates);
          if (role === 'a' && result?.answer && result.generation === session.generation &&
              !pc.remoteDescription) {
            mark('answerReceived');
            await pc.setRemoteDescription(result.answer);
            answered = true;
            if (session.channel?.readyState !== 'open')
              setStatus('negotiating', 'answer accepted; checking ICE');
          }
          if (role === 'b' && result?.offer && result.generation === session.generation &&
              !pc.remoteDescription) {
            if (options.directOnly && / typ (srflx|relay)\b/.test(result.offer.sdp || ''))
              throw new Error('offer incompatible with directOnly');
            mark('offerReceived');
            await pc.setRemoteDescription(result.offer);
            await applyCandidates();
            await pc.setLocalDescription(await pc.createAnswer());
            if (id !== epoch || current !== session || session.cancelled) return;
            await measuredSignal('answer', () =>
              write(options.base, 'answer', role, pc.localDescription, room, session.generation), attempt);
            mark('answerPublished');
            answered = true;
            if (session.channel?.readyState !== 'open')
              setStatus('negotiating', 'answer sent; checking ICE');
          }
          await applyCandidates();
        } catch (error) {
          if (id !== epoch || current !== session) return;
          session.error = error.message;
          if (/HTTP 409|incompatible|description|SDP|InvalidState/i.test(error.message)) {
            setStatus('negotiation-error', error.message + '; reconnect manually');
            return;
          }
          log('signaling retry: ' + error.message);
        }
        if (session.channel?.readyState === 'open') return;
        await sleep(options.pollMs);
      }
      if (id === epoch && !stopped && current === session && !session.cancelled &&
          session.channel?.readyState !== 'open') {
        setStatus('timeout', answered ? 'ICE/data channel did not connect; retry manually'
          : role === 'a' ? 'no answer; retry manually' : 'no offer; press Connect after Reset');
      }
    }
    function defaultMessage(data) {
      const bit = Number.parseInt(data, 10);
      if (!Number.isNaN(bit)) try { window.Controller?.handleBit(bit); } catch (_) {}
    }
    // Only the offerer may create a new generation during initial startup.
    const initialId = ++epoch;
    enqueue(() => begin(initialId, role === 'a'));
    return controller;
  }

  const startA = options => { validateRoom(options.room); return createController('a', options); };
  const startB = options => { validateRoom(options.room); return createController('b', options); };
  window.RTC = {
    rooms,
    startA(options = {}) {
      const controller = startA(options); controllers.set(controller.room, controller);
      return controller.ready.then(() => controller);
    },
    startB(options = {}) {
      const controller = startB(options); controllers.set(controller.room, controller);
      return controller.ready.then(() => controller);
    },
    getController(room = rooms.gameplay) { return controllers.get(room) || null; },
    formatDiagnostics,
    subscribeDiagnostics(callback) {
      diagnosticsListeners.add(callback);
      for (const controller of controllers.values()) {
        if (controller.diagnostics) {
          try { callback(controller.diagnostics); } catch (_) {}
        }
      }
      return () => diagnosticsListeners.delete(callback);
    },
    restart(room = rooms.gameplay) {
      validateRoom(room);
      return controllers.get(room)?.restart() || null;
    },
    send(...args) { return controllers.get(rooms.gameplay)?.send(...args) || false; }
  };
})();
