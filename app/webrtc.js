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
    const listeners = new Set();
    let resolveReady, readyDone = false;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const finishReady = () => { if (!readyDone) { readyDone = true; resolveReady(controller); } };
    const controller = {
      room, role, status: 'new', ready,
      get pc() { return current?.pc || null; },
      get channel() { return current?.channel || null; },
      get error() { return current?.error || null; },
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
      let generation = null;
      if (reset) {
        setStatus('signaling', 'resetting ' + room);
        try {
          const response = await resetRoom(options.base, room);
          if (!response?.generation) throw new Error('signal-reset did not return a generation');
          generation = response.generation;
        } catch (error) {
          if (id === epoch) setStatus('signaling-error', error.message);
          finishReady();
          return;
        }
      }
      if (id !== epoch || stopped) return;
      const session = {
        pc: null, channel: null, generation, cancelled: false,
        pendingCandidates: [], error: null, started: performance.now()
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
          if (current === session && pc.iceConnectionState === 'failed')
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
          void write(options.base, 'candidate', role, candidate, room, session.generation)
            .catch(error => { if (current === session) log('ICE candidate write: ' + error.message); });
        };
        options.preparePc?.(pc);
        if (role === 'a') {
          await pc.setLocalDescription(await pc.createOffer());
          if (id !== epoch || session.cancelled) return;
          await write(options.base, 'offer', role, pc.localDescription, room, session.generation);
          setStatus('negotiating', 'offer sent after ' + elapsed() + '; waiting for answer');
        }
        await pollSignal(id, session);
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

    async function pollSignal(id, session) {
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
          const result = await read(options.base, role, room);
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
            await pc.setRemoteDescription(result.answer);
            answered = true;
            setStatus('negotiating', 'answer accepted; checking ICE');
          }
          if (role === 'b' && result?.offer && result.generation === session.generation &&
              !pc.remoteDescription) {
            if (options.directOnly && / typ (srflx|relay)\b/.test(result.offer.sdp || ''))
              throw new Error('offer incompatible with directOnly');
            await pc.setRemoteDescription(result.offer);
            await applyCandidates();
            await pc.setLocalDescription(await pc.createAnswer());
            if (id !== epoch || current !== session || session.cancelled) return;
            await write(options.base, 'answer', role, pc.localDescription, room, session.generation);
            answered = true;
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
    restart(room = rooms.gameplay) {
      validateRoom(room);
      return controllers.get(room)?.restart() || null;
    },
    send(...args) { return controllers.get(rooms.gameplay)?.send(...args) || false; }
  };
})();
