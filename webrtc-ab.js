/*!
  Minimal WebRTC A/B helper for Netlify Blobs signaling (single room).
  Usage in each HTML:
    <script src="webrtc-ab.js"></script>
    <script>
      // A (top.html)
      StartA();
      // B (index.html)
      StartB();
    </script>
*/
(() => {
  const DEFAULTS = {
    base: '/.netlify/functions',
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    timeoutMs: 120000, // 2 minutes
    backoff: [400, 800, 1500, 3000, 5000],
    log: (...args) => console.log(...args),
    onOpen: () => {},
    onMessage: () => {},
    onState: () => {}
  };

  // -------- HTTP helpers (no-store + cache buster) --------
  const j = (o)=>JSON.stringify(o);
  const qs = () => `_=${Date.now()}`;
  async function post(base, name, body) {
    const r = await fetch(`${base}/${name}?${qs()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: j(body)
    });
    return r;
  }
  async function get(base, name, params) {
    const u = new URL(`${base}/${name}`, location.href);
    Object.entries(params || {}).forEach(([k,v]) => u.searchParams.set(k, v));
    u.searchParams.set('_', Date.now().toString());
    const r = await fetch(u.toString(), { cache: 'no-store' });
    return r.ok ? r.json() : Promise.reject(new Error(`GET ${name} ${r.status}`));
  }

  // -------- Signaling wrappers --------
  const resetRoom = (base) => post(base, 'signal-reset', {});
  const write = (base, kind, role, data) => post(base, 'signal-write', { kind, role, data });
  const readA = (base) => get(base, 'signal-read', { role: 'a' });
  const readB = (base) => get(base, 'signal-read', { role: 'b' });

  // -------- WebRTC helpers --------
  const waitIceComplete = (pc) => new Promise((res) => {
    if (pc.iceGatheringState === 'complete') return res();
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') res();
    });
  });
  const until = (ms) => new Promise(r => setTimeout(r, ms));

  function wirePc(pc, opts, channelMaybe) {
    const { log, onState } = opts;
    pc.addEventListener('iceconnectionstatechange', () => log('ice:', pc.iceConnectionState));
    pc.addEventListener('connectionstatechange', () => {
      log('pc.connectionState:', pc.connectionState);
      onState(pc.connectionState);
    });
    if (channelMaybe) {
      const { onOpen, onMessage } = opts;
      channelMaybe.onopen = () => onOpen(channelMaybe, pc);
      channelMaybe.onmessage = (e) => onMessage(String(e.data), channelMaybe, pc);
    } else {
      pc.ondatachannel = (e) => {
        const ch = e.channel;
        const { onOpen, onMessage } = opts;
        ch.onopen = () => onOpen(ch, pc);
        ch.onmessage = (ev) => onMessage(String(ev.data), ch, pc);
      };
    }
  }

  function makeController(pc, ch, log) {
    return {
      pc,
      channel: ch || null,
      send: (msg) => ch && ch.readyState === 'open' ? ch.send(msg) : false,
      stop: () => { try { ch && ch.close(); } catch{} try { pc.close(); } catch{} log('stopped'); }
    };
  }

  // -------- Public APIs --------

  // Peer A: reset room, batch-ICE offer, poll ONLY for answer (backoff + timeout)
  window.StartA = async function StartA(userOpts = {}) {
    const opts = { ...DEFAULTS, ...userOpts };
    const { base, iceServers, timeoutMs, backoff, log } = opts;

    // 1) Reset room
    const r = await resetRoom(base);
    if (!r.ok) { log('reset failed', r.status); throw new Error('reset failed'); }
    log('room: reset done');

    // 2) Create PC and DataChannel
    const pc = new RTCPeerConnection({ iceServers });
    const ch = pc.createDataChannel('chat');
    wirePc(pc, opts, ch);

    // 3) Batch ICE: send offer after gathering completes
    await pc.setLocalDescription(await pc.createOffer());
    await waitIceComplete(pc);
    await write(base, 'offer', 'a', pc.localDescription);
    log('sent: offer (batched ICE)');

    // 4) Poll only for ANSWER with adaptive backoff + timeout
    const t0 = Date.now();
    let i = 0;
    while (true) {
      if (Date.now() - t0 > timeoutMs) { log('timeout: no answer — stopping'); break; }
      const { answer } = await readA(base).catch(e => { log('readA error', e.message); return {}; });
      if (answer && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(answer);
        log('got: answer (Peer B joined)');
        break;
      }
      await until(backoff[i]); i = Math.min(i + 1, backoff.length - 1);
    }

    return makeController(pc, ch, log);
  };

  // Peer B: single check for offer; if absent => quit. If present => batch-ICE answer.
  window.StartB = async function StartB(userOpts = {}) {
    const opts = { ...DEFAULTS, ...userOpts };
    const { base, iceServers, timeoutMs, log } = opts;

    // 1) Single check — is A present? (offer exists)
    const first = await readB(base).catch(e => { log('readB error', e.message); return {}; });
    if (!first || !first.offer) {
      log('no offer found — open A (top.html) first'); // quit early
      return { status: 'no-offer', pc: null, channel: null, send: () => false, stop: () => {} };
    }

    // 2) Create PC only if offer exists
    const pc = new RTCPeerConnection({ iceServers });
    wirePc(pc, opts, null);

    // 3) Set remote offer, create batched answer
    await pc.setRemoteDescription(first.offer);
    log('got: offer');
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIceComplete(pc);
    await write(base, 'answer', 'b', pc.localDescription);
    log('sent: answer (batched ICE)');

    // 4) Optional: timeout watcher for connection establishment
    const t0 = Date.now();
    (async function watch() {
      if (!pc) return;
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') return;
      if (Date.now() - t0 > timeoutMs) { log('timeout: connection not established'); return; }
      await until(1000); watch();
    })();

    return makeController(pc, null, log);
  };
})();

