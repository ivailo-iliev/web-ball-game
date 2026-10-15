// Deterministic two-device signaling diagnostics test. No real ICE/network needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const rooms = new Map();
let reads = 0, resets = 0;
const getRoom = id => {
  if (!rooms.has(id)) rooms.set(id, { generation: null, offer: null, answer: null, a: [], b: [] });
  return rooms.get(id);
};
const response = data => ({
  ok: true, status: 200, headers: { get: () => 'application/json' },
  json: async () => data
});
async function fetchSignal(url, options = {}) {
  await wait(4); // Nonzero backend time to verify latency measurements.
  const endpoint = new URL(url).pathname.split('/').pop();
  const body = options.body ? JSON.parse(options.body) : {};
  const parsed = new URL(url);
  const room = getRoom(body.room || parsed.searchParams.get('room') || 'default');
  if (endpoint === 'signal-reset') {
    room.generation = String(++resets);
    room.offer = room.answer = null;
    room.a = []; room.b = [];
    return response({ generation: room.generation });
  }
  if (endpoint === 'signal-write') {
    assert.equal(body.generation, room.generation);
    if (body.kind === 'candidate') room[body.role].push(body.data);
    else room[body.kind] = body.data;
    return response({ ok: true });
  }
  assert.equal(endpoint, 'signal-read');
  reads++;
  const incoming = parsed.searchParams.get('role') === 'a' ? 'b' : 'a';
  return response({
    generation: room.generation, offer: room.offer, answer: room.answer,
    candidates: room[incoming].splice(0)
  });
}

const peers = [];
class Peer {
  connectionState = 'new';
  iceConnectionState = 'new';
  constructor() { peers.push(this); }
  createDataChannel() { return this.channel = { readyState: 'connecting', send() {}, close() {} }; }
  async createOffer() { return { type: 'offer', sdp: 'unit-offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'unit-answer' }; }
  async setLocalDescription(sdp) {
    this.localDescription = sdp;
    if (sdp.type === 'answer') {
      this.channel = { readyState: 'connecting', send() {}, close() {} };
      this.ondatachannel?.({ channel: this.channel });
    }
    queueMicrotask(() => this.onicecandidate?.({
      candidate: { toJSON: () => ({ candidate: 'candidate:1 typ host', sdpMid: '0', sdpMLineIndex: 0 }) }
    }));
  }
  async setRemoteDescription(sdp) {
    this.remoteDescription = sdp;
    if (sdp.type === 'answer') {
      const peer = [...peers].reverse().find(p => p !== this && p.localDescription?.type === 'answer'
        && p.connectionState !== 'connected' && p.connectionState !== 'closed');
      assert.ok(peer, 'responder exists');
      this.connectionState = peer.connectionState = 'connected';
      this.iceConnectionState = peer.iceConnectionState = 'connected';
      this.channel.readyState = peer.channel.readyState = 'open';
      queueMicrotask(() => {
        this.oniceconnectionstatechange?.();
        peer.oniceconnectionstatechange?.();
        this.channel.onopen?.();
        peer.channel.onopen?.();
      });
    }
  }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }
}

const code = readFileSync('app/webrtc.js', 'utf8');
const start = path => {
  const window = {};
  vm.runInNewContext(code, {
    window, location: { href: 'https://test/' + path }, fetch: fetchSignal,
    URL, console, setTimeout, performance, queueMicrotask, RTCPeerConnection: Peer,
    document: { getElementById: () => null }
  });
  return window.RTC;
};
const a = start('top.html'), b = start('index.html');
const observedA = [], observedB = [];
a.subscribeDiagnostics(data => observedA.push(data));
b.subscribeDiagnostics(data => observedB.push(data));
const openA = a.startA({ pollMs: 5, timeoutMs: 2500, log() {} });
for (let i = 0; i < 100 && !getRoom('default').offer; i++) await wait(5);
assert.ok(getRoom('default').offer, 'offer published before join');
const openB = b.startB({ pollMs: 5, timeoutMs: 2500, log() {} });
const [offerer, responder] = await Promise.all([openA, openB]);
const assertConnected = () => {
  assert.equal(offerer.channel?.readyState, 'open');
  assert.equal(responder.channel?.readyState, 'open');
  for (const [controller, role] of [[offerer, 'a'], [responder, 'b']]) {
    assert.equal(controller.diagnostics.status, 'connected');
    assert.equal(controller.diagnostics.role, role);
    for (const key of ['iceConnected', 'channelOpen']) {
      assert.ok(Number.isFinite(controller.diagnostics.stages[key]), key + ' measured');
    }
    assert.ok(controller.diagnostics.signaling.requests > 0);
    assert.ok(controller.diagnostics.signaling.totalMs > 0);
    assert.ok(controller.diagnostics.signaling.maxMs > 0);
    assert.match(a.formatDiagnostics(controller.diagnostics), /Netlify: \d+ calls/);
  }
};
assertConnected();
assert.equal(resets, 1, 'only offerer resets room');
for (const key of ['reset', 'offerPublished', 'answerReceived']) {
  assert.ok(Number.isFinite(offerer.diagnostics.stages[key]), key);
}
for (const key of ['offerReceived', 'answerPublished']) {
  assert.ok(Number.isFinite(responder.diagnostics.stages[key]), key);
}
const readCount = reads;
await wait(45);
assert.equal(reads, readCount, 'no signaling reads after data channels opened');
assert.ok(observedA.length > 3 && observedB.length > 3, 'live diagnostics emitted');

const old = offerer.diagnostics.stages.channelOpen;
const restartA = a.restart('default');
for (let i = 0; i < 100 && resets === 1; i++) await wait(5);
assert.equal(resets, 2, 'manual offerer restart resets room');
for (let i = 0; i < 100 && !getRoom('default').offer; i++) await wait(5);
assert.ok(getRoom('default').offer, 'new offer published');
const restartB = b.restart('default');
await Promise.all([restartA, restartB]);
assertConnected();
assert.notEqual(offerer.pc, peers[0], 'fresh peer after restart');
assert.ok(Number.isFinite(offerer.diagnostics.stages.channelOpen));
assert.ok(old >= 0, 'previous timing was recorded');
assert.equal(resets, 2, 'responder restart does not reset');
const after = reads;
await wait(45);
assert.equal(reads, after, 'no post-restart Netlify polling');
console.log('PASS negotiation diagnostics: timed phases, Netlify latency, manual reset, no polling after connection');
