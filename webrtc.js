/*!
  Minimal WebRTC A/B helper (single room, reset-on-start).
  Endpoints expected:
    /.netlify/functions/signal-reset
    /.netlify/functions/signal-write
    /.netlify/functions/signal-read
  Usage:
    // A (top.html)
    StartA({ log: console.log, timeoutMs: 300000 }); // 5 min
    // B (index.html)
    StartB({ log: console.log });
*/
(() => {
  const DEFAULTS = {
    base: '/.netlify/functions',
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    directOnly: false,                 // if true → iceServers: []
    timeoutMs: 300000,                 // A waits up to 5 minutes for answer
    backoff: [400, 800, 1500, 3000, 5000],
    log: () => {},
    onOpen: () => {},                  // (channel, pc)
    onMessage: () => {},               // (msg, channel, pc)
    onState: () => {}                  // (pc.connectionState)
  };

  // ---------- Helpers ----------
  const qsBust = (u) => { u.searchParams.set('_', Date.now().toString()); return u; };
  async function fetchJson(base, name, { method='GET', params=null, body=null } = {}) {
    const u = new URL(`${base}/${name}`, location.href);
    if (params) Object.entries(params).forEach(([k,v]) => u.searchParams.set(k, v));
    qsBust(u);
    const opt = { method, cache:'no-store', headers:{} };
    if (body != null) {
      opt.headers['content-type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const r = await fetch(u.toString(), opt);
    if (!r.ok) throw new Error(`${name} ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('application/json') ? r.json() : r.text();
  }

  // signaling wrappers
  const resetRoom = (base) => fetchJson(base, 'signal-reset', { method:'POST', body:{} });
  const write     = (base, kind, role, data) => fetchJson(base, 'signal-write', { method:'POST', body:{ kind, role, data } });
  const readRole  = (base, role) => fetchJson(base, 'signal-read', { params:{ role } });

  // ICE helpers
  const waitIceComplete = (pc) => new Promise(res => {
    if (pc.iceGatheringState === 'complete') return res();
    const on = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', on); res(); } };
    pc.addEventListener('icegatheringstatechange', on);
  });
  const until = (ms) => new Promise(r => setTimeout(r, ms));
  const isHostOnlySdp = (sdp) => !/ typ (srflx|relay)\b/.test(sdp);

  function wirePc(pc, opts, listeners, channelMaybe) {
    const { log, onState } = opts;
    const add = (target, ev, fn) => { target.addEventListener(ev, fn); listeners.push(() => target.removeEventListener(ev, fn)); };

    add(pc, 'iceconnectionstatechange', () => log('ice:', pc.iceConnectionState));
    add(pc, 'connectionstatechange', () => { log('pc.connectionState:', pc.connectionState); onState(pc.connectionState); });
    add(pc, 'icecandidateerror', (e) => log('ICE error:', e.errorText || e.errorCode || 'unknown'));

    const hookChannel = (ch) => {
      ch.onopen = () => opts.onOpen(ch, pc);
      ch.onmessage = (e) => opts.onMessage(String(e.data), ch, pc);
    };

    if (channelMaybe) {
      hookChannel(channelMaybe);
    } else {
      add(pc, 'datachannel', (e) => hookChannel(e.channel));
    }
  }

  function makeController({ pc, channel, log, offFns, cancelFlag }) {
    return {
      pc,
      channel: channel || null,
      send: (msg) => channel && channel.readyState === 'open' ? (channel.send(msg), true) : false,
      stop: () => {
        cancelFlag.cancelled = true;
        try { offFns.forEach(fn => fn()); } catch {}
        try { if (channel) { channel.onopen = channel.onmessage = null; channel.close(); } } catch {}
        try { pc.ondatachannel = null; pc.close(); } catch {}
        log('stopped');
      }
    };
  }

  // ---------- Public APIs ----------

  // Peer A: reset room, batch ICE offer, poll for answer with backoff+timeout
  window.StartA = async function StartA(userOpts = {}) {
    const opts = { ...DEFAULTS, ...userOpts };
    const { base, timeoutMs, backoff, log } = opts;
    const iceServers = opts.directOnly ? [] : (opts.iceServers || []);

    // cleanup on start
    try {
      await resetRoom(base);
      log('room: reset done');
    } catch (e) {
      log('reset failed:', e.message);
      throw e;
    }

    // PC + DC
    const pc = new RTCPeerConnection({ iceServers });
    const offFns = [];
    const cancelFlag = { cancelled:false };
    const channel = pc.createDataChannel('chat');
    wirePc(pc, opts, offFns, channel);

    // batch ICE offer
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await waitIceComplete(pc);
      await write(base, 'offer', 'a', pc.localDescription);
      log('sent: offer (batched ICE)');
    } catch (e) {
      log('offer/SDP failed:', e.message);
      return makeController({ pc, channel, log, offFns, cancelFlag });
    }

    // wait for answer with adaptive backoff (stops when answer set or timeout)
    const t0 = Date.now();
    let i = 0;
    while (!cancelFlag.cancelled) {
      if (Date.now() - t0 > timeoutMs) { log('timeout: no answer — stopping'); break; }
      let answer = null;
      try {
        const r = await readRole(base, 'a');
        answer = r && r.answer;
      } catch (e) { log('read answer error:', e.message); }

      if (answer && !pc.currentRemoteDescription) {
        try {
          await pc.setRemoteDescription(answer);
          log('got: answer (Peer B joined)');
        } catch (e) {
          log('setRemoteDescription failed:', e.message);
        }
        break;
      }
      await until(backoff[i]); i = Math.min(i + 1, backoff.length - 1);
    }

    return makeController({ pc, channel, log, offFns, cancelFlag });
  };

  // Peer B: check once for offer; if absent → quit. If present → batch ICE answer.
  window.StartB = async function StartB(userOpts = {}) {
    const opts = { ...DEFAULTS, ...userOpts };
    const { base, log } = opts;
    const iceServers = opts.directOnly ? [] : (opts.iceServers || []);

    // single read for offer
    let initial;
    try {
      initial = await readRole(base, 'b');
    } catch (e) {
      log('read offer error:', e.message);
      return { status: 'error', pc: null, channel: null, send: () => false, stop: () => {} };
    }
    const offer = initial && initial.offer;
    if (!offer) {
      log('no offer found — open A (top.html) first');
      return { status: 'no-offer', pc: null, channel: null, send: () => false, stop: () => {} };
    }
    if (opts.directOnly && !isHostOnlySdp(offer.sdp || '')) {
      log('offer is not host-only (directOnly=true) — quitting');
      return { status: 'not-host-offer', pc: null, channel: null, send: () => false, stop: () => {} };
    }

    // proceed
    const pc = new RTCPeerConnection({ iceServers });
    const offFns = [];
    const cancelFlag = { cancelled:false };
    wirePc(pc, opts, offFns, null);

    try {
      await pc.setRemoteDescription(offer);
      log('got: offer');
      await pc.setLocalDescription(await pc.createAnswer());
      await waitIceComplete(pc);
      await write(base, 'answer', 'b', pc.localDescription);
      log('sent: answer (batched ICE)');
    } catch (e) {
      log('answer/SDP failed:', e.message);
    }

    return makeController({ pc, channel:null, log, offFns, cancelFlag });
  };
})();
