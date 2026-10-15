/*!
  Minimal WebRTC helper for the three independent fixed rooms.
  Pages select a role with startA/startB and can explicitly restart a room.
*/
(() => {
  const rooms = Object.freeze({ gameplay: 'default', top: 'calibration-top', front: 'calibration-front' });
  const DEFAULTS = { room: rooms.gameplay, base: '/.netlify/functions', iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], directOnly: false, timeoutMs: 300000, backoff: [400, 800, 1500, 3000, 5000] };
  const controllers = new Map();
  const qsBust = u => (u.searchParams.set('_', Date.now().toString()), u);
  async function fetchJson(base, name, { method='GET', params=null, body=null } = {}) {
    const u = new URL(`${base}/${name}`, location.href);
    if (params) Object.entries(params).forEach(([k,v]) => u.searchParams.set(k, v));
    const r = await fetch(qsBust(u), { method, cache:'no-store', headers: body == null ? {} : { 'content-type':'application/json' }, ...(body == null ? {} : { body:JSON.stringify(body) }) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${name} ${r.status}`);
    return (r.headers.get('content-type') || '').includes('application/json') ? r.json() : r.text();
  }
  const resetRoom = (base, room) => fetchJson(base, 'signal-reset', { method:'POST', body:{ room } });
  const write = (base, kind, role, data, room, generation) => fetchJson(base, 'signal-write', { method:'POST', body:{ kind, role, data, room, generation } });
  const readRole = (base, role, room) => fetchJson(base, 'signal-read', { params:{ role, room } });
  const validateRoom = room => { if (room !== undefined && (typeof room !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(room))) throw new Error('Invalid room'); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function waitIceComplete(pc, timeoutMs, cancelled) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('ICE gathering timed out')), timeoutMs);
      const onChange = () => { if (pc.iceGatheringState === 'complete') finish(); };
      const finish = error => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', onChange); cancelled.add(finish); error ? reject(error) : resolve(); };
      cancelled.add(() => finish(new Error('Connection attempt cancelled')));
      pc.addEventListener('icegatheringstatechange', onChange);
    });
  }
  function createController(role, initialOptions) {
    const room = initialOptions.room || rooms.gameplay;
    let options = { ...DEFAULTS, ...initialOptions, room };
    let log = options.log || (msg => { const el = document.getElementById('state'); if (el) el.textContent = String(msg); console.log(msg); });
    let epoch = 0, current = null, stopped = false, serial = Promise.resolve(), status = 'new';
    const listeners = new Set();
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    let readyDone = false;
    const finishReady = () => { if (!readyDone) { readyDone = true; resolveReady(controller); } };
    const controller = {
      room, role, status, ready,
      get pc() { return current && current.pc || null; },
      get channel() { return current && current.channel || null; },
      get error() { return current && current.error || null; },
      onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      send(msg) { const ch = controller.channel; if (!ch || ch.readyState !== 'open') return false; ch.send(msg); return true; },
      stop() { stopped = true; epoch++; dispose(current); current = null; setStatus('stopped'); },
      restart() { stopped = false; const id = ++epoch; dispose(current); current = null; return enqueue(() => begin(id, true)); }
    };
    function setStatus(value, detail='') { status = controller.status = value; log(detail ? `${value}: ${detail}` : value); if (options.onState) { try { options.onState(value, detail, controller); } catch {} } listeners.forEach(fn => { try { fn(value, detail, controller); } catch {} }); }
    function dispose(session) {
      if (!session) return;
      session.cancelled = true;
      session.cancel.forEach(fn => { try { fn(); } catch {} });
      session.off.forEach(fn => { try { fn(); } catch {} });
      try { if (session.channel) { session.channel.onopen = session.channel.onmessage = null; session.channel.close(); } } catch {}
      try { session.pc.ondatachannel = null; session.pc.close(); } catch {}
    }
    function enqueue(fn) { serial = serial.catch(() => {}).then(fn); return serial; }
    async function begin(id, reset, inheritedGeneration) {
      if (stopped || id !== epoch) return;
      if (reset) {
        setStatus('signaling', 'resetting room');
        try { const result = await resetRoom(options.base, room); if (!result) throw new Error('signal-reset missing'); inheritedGeneration = result.generation; }
        catch (e) { if (id === epoch) setStatus('signaling-error', e.message); finishReady(); return; }
      }
      if (id !== epoch) return;
      setStatus('negotiating', 'creating peer');
      const session = { pc:new RTCPeerConnection({ iceServers:options.directOnly ? [] : options.iceServers || [] }), channel:null, cancel:new Set(), off:[], cancelled:false, error:null, generation:inheritedGeneration };
      current = session;
      const pc = session.pc;
      const add = (target, event, fn) => { target.addEventListener(event, fn); session.off.push(() => target.removeEventListener(event, fn)); };
      const on = (ch) => { session.channel = ch; ch.onopen = () => { if (current === session) { setStatus('connected', 'data channel open'); if (options.onOpen) options.onOpen(ch, pc); } }; ch.onclose = () => { if (current === session && !stopped) setStatus('data-channel-error', 'channel closed'); }; ch.onerror = () => { if (current === session) setStatus('data-channel-error', 'channel error'); }; ch.onmessage = e => { try { options.onMessage ? options.onMessage(String(e.data), ch, pc) : defaultMessage(String(e.data)); } catch (e) { log(`data-channel error: ${e.message}`); } }; };
      add(pc, 'connectionstatechange', () => { if (current !== session) return; const s = pc.connectionState; if (s === 'connected' && session.channel && session.channel.readyState === 'open') setStatus('connected'); else if (s === 'failed') setStatus('negotiation-error', 'peer connection failed; use refresh to retry'); else if (s === 'disconnected') setStatus('negotiating', 'peer temporarily disconnected'); else setStatus('negotiating', `peer ${s}`); });
      add(pc, 'iceconnectionstatechange', () => { if (pc.iceConnectionState === 'failed' && current === session) setStatus('negotiation-error', 'ICE failed; use refresh to retry'); });
      add(pc, 'icecandidateerror', e => { session.error = e.errorText || e.errorCode || 'ICE candidate error'; if (current === session) log(`signaling/ICE diagnostic: ${session.error}`); });
      add(pc, 'track', e => { if (current === session) { session.trackSeen = true; if (options.onTrack) { try { options.onTrack(e); } catch (error) { session.error = error.message; setStatus('media-track-error', error.message); } } const track = e.track; if (track) { const ended = () => { if (current === session) setStatus('media-track-error', 'remote track ended'); }; add(track, 'ended', ended); add(track, 'mute', () => { if (current === session) log('media-track diagnostic: remote track muted'); }); add(track, 'unmute', () => { if (current === session) log('media-track diagnostic: remote track resumed'); }); } } });
      pc.ondatachannel = e => on(e.channel);
      if (role === 'a') { session.channel = pc.createDataChannel('chat'); on(session.channel); }
      options.preparePc?.(pc);
      try {
        if (role === 'a') {
          const offer = await pc.createOffer(); if (id !== epoch) return;
          await pc.setLocalDescription(offer); await waitIceComplete(pc, options.timeoutMs, session.cancel); if (id !== epoch) return;
          const sent = await write(options.base, 'offer', 'a', pc.localDescription, room, inheritedGeneration); if (!sent) throw new Error('offer write missing');
          setStatus('negotiating', 'offer sent; waiting for answer');
          await pollAnswer(id, session, inheritedGeneration);
        } else {
          await pollOffer(id, session, inheritedGeneration);
        }
      } catch (e) { if (id === epoch && !stopped) { session.error = e.message; setStatus(/write|read|reset|signal/i.test(e.message) ? 'signaling-error' : 'negotiation-error', e.message); dispose(session); current = null; } finishReady(); }
    }
    async function pollAnswer(id, session, generation) {
      const started = Date.now(); let n = 0;
      while (id === epoch && !stopped && Date.now() - started < options.timeoutMs) {
        try {
          const result = await readRole(options.base, 'a', room);
          if (id !== epoch) return;
          if (result && result.generation !== generation && result.generation) { dispose(session); current = null; return begin(id, false, result.generation); }
          if (result && result.answer && result.generation === generation && !session.pc.currentRemoteDescription) {
            await session.pc.setRemoteDescription(result.answer); setStatus('negotiating', 'answer accepted; checking ICE/data channel'); finishReady(); return;
          }
        } catch (e) { if (id === epoch) log(`signaling retry: answer read: ${e.message}`); }
        await sleep(options.backoff[Math.min(n++, options.backoff.length - 1)] || 1000);
      }
      if (id === epoch && !stopped) { setStatus('timeout', 'no answer; use refresh to restart'); dispose(session); current = null; }
      finishReady();
    }
    async function pollOffer(id, session, generation) {
      const started = Date.now(); let n = 0;
      while (id === epoch && !stopped && Date.now() - started < options.timeoutMs) {
        try {
          const result = await readRole(options.base, 'b', room);
          if (id !== epoch) return;
          if (result && result.generation && result.generation !== generation) {
            if (generation) {
              dispose(session); current = null;
              return begin(id, false, result.generation);
            }
            generation = session.generation = result.generation;
          }
          const offer = result && result.generation === generation && result.offer;
          if (offer) {
            if (options.directOnly && !isHostOnlySdp(offer.sdp || '')) throw new Error('offer incompatible with directOnly');
            await session.pc.setRemoteDescription(offer);
            const answer = await session.pc.createAnswer(); await session.pc.setLocalDescription(answer);
            await waitIceComplete(session.pc, options.timeoutMs, session.cancel);
            const sent = await write(options.base, 'answer', 'b', session.pc.localDescription, room, generation); if (!sent) throw new Error('answer write missing');
            setStatus('negotiating', 'answer sent; checking ICE/data channel'); finishReady(); return;
          }
        } catch (e) {
          if (id === epoch && (/SDP|description|offer incompatible/i.test(e.message) || ['InvalidAccessError', 'OperationError', 'TypeError'].includes(e.name))) {
            session.error = e.message; setStatus('negotiation-error', e.message); dispose(session); current = null; finishReady(); return;
          }
          if (id === epoch) log(`signaling/negotiation retry: offer: ${e.message}`);
        }
        await sleep(options.backoff[Math.min(n++, options.backoff.length - 1)] || 1000);
      }
      if (id === epoch && !stopped) { setStatus('timeout', 'no offer; use refresh to restart'); dispose(session); current = null; }
    }
    function defaultMessage(data) { const bit = Number.parseInt(data, 10); if (!Number.isNaN(bit)) try { window.Controller && window.Controller.handleBit(bit); } catch {} }
    function isHostOnlySdp(sdp) { return !/ typ (srflx|relay)\b/.test(sdp); }
    function start(reset) { stopped = false; const id = ++epoch; dispose(current); current = null; enqueue(() => begin(id, reset)); return controller; }
    start(true);
    return controller;
  }
  function startA(options={}) { validateRoom(options.room); return createController('a', options); }
  function startB(options={}) { validateRoom(options.room); return createController('b', options); }
  function getController(room=rooms.gameplay) { return controllers.get(room) || null; }
  function restart(room=rooms.gameplay) { validateRoom(room); const ctrl = controllers.get(room); return ctrl ? ctrl.restart() : null; }
  window.RTC = { rooms, startA, startB, getController, restart, send: (...args) => (controllers.get(rooms.gameplay)?.send(...args) || false) };
  const originalA = startA, originalB = startB;
  window.RTC.startA = options => { const c = originalA(options); controllers.set(c.room, c); return c.ready.then(() => c); };
  window.RTC.startB = options => { const c = originalB(options); controllers.set(c.room, c); return c.ready.then(() => c); };
})();