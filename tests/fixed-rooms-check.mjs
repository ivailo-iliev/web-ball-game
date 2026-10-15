// Focused unit checks, not the downstream real-browser/Netlify integration driver.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { signalFixture } from './calibration-check.mjs';

const { handlers, blobs } = signalFixture();
const request = (name, body, room = 'default', role = 'a') => handlers[name](new Request(
  `https://test/.netlify/functions/signal-${name}?${new URLSearchParams({ room, role })}`,
  { method: name === 'read' ? 'GET' : 'POST', ...(name === 'read' ? {} : { body: JSON.stringify(body) }) }
), {});
const rooms = ['default', 'calibration-top', 'calibration-front'];
const generations = {};
for (const room of rooms) {
  generations[room] = (await (await request('reset', { room })).json()).generation;
  for (const kind of ['offer', 'answer', 'candidate']) {
    assert.equal((await request('write', { room, generation: generations[room], kind, role: 'b', data: { room, kind } })).status, 200);
  }
}
for (const room of rooms) {
  const result = await (await request('read', null, room)).json();
  assert.equal(result.generation, generations[room]);
  assert.equal(result.offer.room, room);
  assert.equal(result.answer.room, room);
  assert.deepEqual(result.candidates, [{ room, kind: 'candidate' }]);
  assert.deepEqual((await (await request('read', null, room)).json()).candidates, []);
}
for (const room of rooms) {
  const otherKeys = [...blobs.entries()].filter(([key]) => !key.startsWith(`room/${room}/`));
  const old = generations[room];
  generations[room] = (await (await request('reset', { room })).json()).generation;
  assert.notEqual(generations[room], old);
  const result = await (await request('read', null, room)).json();
  assert.equal(result.offer, null);
  assert.equal(result.answer, null);
  for (const kind of ['offer', 'answer', 'candidate']) {
    for (const generation of [old, undefined]) {
      assert.equal((await request('write', { room, generation, kind, role: 'b', data: {} })).status, 409);
    }
  }
  // A write already in flight before reset can finish in its old namespace only.
  blobs.set(`room/${room}/generations/${old}/answer.json`, { stale: true });
  assert.equal((await (await request('read', null, room)).json()).answer, null);
  assert.deepEqual([...blobs.entries()].filter(([key]) => !key.startsWith(`room/${room}/`)), otherKeys);
}
assert.equal((await (await handlers.read(new Request('https://test/?role=a'), {})).json()).generation, generations.default);
console.log('PASS fixed storage: three rooms, offer/answer/ICE reads and pops, every reset isolated, stale writes rejected/hidden, omitted gameplay alias');

// Execute the actual RTC helper against the handlers with a minimal unit-test PC.
// This verifies routing/generation wiring, not real network negotiation.
class Peer {
  connectionState = 'new';
  iceConnectionState = 'new';
  addEventListener() {}
  removeEventListener() {}
  createDataChannel() {
    this.channel = { readyState: 'connecting', send() {}, close() {} };
    return this.channel;
  }
  async createOffer() { return { type: 'offer', sdp: 'unit-offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'unit-answer' }; }
  async setLocalDescription(value) {
    this.localDescription = value;
    if (value.type === 'answer') {
      const channel = { readyState: 'open', send() {}, close() {} };
      this.ondatachannel?.({ channel });
      queueMicrotask(() => channel.onopen?.());
    }
  }
  async setRemoteDescription(value) {
    this.remoteDescription = this.currentRemoteDescription = value;
    if (value.type === 'answer' && this.channel) {
      this.channel.readyState = 'open';
      queueMicrotask(() => this.channel.onopen?.());
    }
  }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }
}
const window = {};
const sandbox = { window, document: { getElementById: () => null }, location: { href: 'https://test/top.html' },
  URL, console, setTimeout, performance, queueMicrotask, RTCPeerConnection: Peer,
  fetch: async (url, options) => {
    const name = new URL(url).pathname.split('-').pop();
    return handlers[name](new Request(url, options), {});
  }
};
vm.runInNewContext(readFileSync('app/webrtc.js', 'utf8'), sandbox);
sandbox.RTC = window.RTC;
assert.deepEqual(Object.values(window.RTC.rooms), rooms);
const controls = [];
for (const room of rooms) {
  const a = window.RTC.startA({ ...(room === 'default' ? {} : { room }), timeoutMs: 1000, pollMs: 5, log() {} });
  for (let i = 0; i < 100; i++) {
    const signal = await (await request('read', null, room, 'b')).json();
    if (signal.offer) break;
    await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(i < 99, 'A publishes an offer');
  }
  const originalSend = window.RTC.send;
  const originalGeneration = (await (await request('read', null, room, 'b')).json()).generation;
  const b = await window.RTC.startB({ ...(room === 'default' ? {} : { room }), pollMs: 5, log() {} });
  assert.equal((await (await request('read', null, room, 'b')).json()).generation,
    originalGeneration, 'B must never reset a room');
  const ctrl = await a;
  assert.equal(ctrl.pc.currentRemoteDescription.type, 'answer');
  assert.equal(b.pc.currentRemoteDescription.type, 'offer');
  if (room !== 'default') assert.equal(window.RTC.send, originalSend);
  controls.push(ctrl, b);
}
controls.forEach(ctrl => ctrl.stop());
console.log('PASS RTC wiring: normal gameplay defaults and both calibration rooms exchange only their generation; calibration preserves RTC.send');

// The workstation opens immediately and emits normal phone URLs even if an old
// bookmarked query string is present. Internal source is a role selector only.
const panes = [];
const node = tag => ({ tag, children: [], setAttribute() {}, addEventListener() {}, append(...children) { this.children.push(...children); } });
vm.runInNewContext(readFileSync('app/calibrate.js', 'utf8'), {
  window: { addEventListener() {} },
  document: { createElement: node, getElementById: () => ({ append: section => panes.push(section) }) },
  location: { href: 'https://test/calibrate.html?calibration=old-session' }, URL, URLSearchParams
});
assert.equal(panes.length, 2);
assert.deepEqual(panes.map(section => section.children[1].value), ['https://test/top.html', 'https://test/index.html']);
assert.deepEqual(panes.map(section => section.children[6].src), ['calibration-pane.html?source=top', 'calibration-pane.html?source=front']);
assert.ok(panes.every(section => section.children[4].textContent.includes('Waiting for calibration')));
assert.deepEqual(panes.map(section => section.children[3].children[0].children.map(option => option.value)),
  [['2', '5', '10', '15', '30'], ['2', '5', '10', '15', '30']]);
assert.ok(!readFileSync('calibrate.html', 'utf8').includes('name="calibration"'));
const manifestURL = new URL(JSON.parse(readFileSync('manifest.json')).start_url, 'https://test/manifest.json');
assert.equal(manifestURL.search, '');

// Run each phone bootstrap without a query, as on normal navigation/PWA launch.
for (const pathname of ['/top.html', '/index.html', '/']) {
  const started = [];
  const track = { requestFrame() {}, stop() {} };
  const stream = { getVideoTracks: () => [track] };
  const phoneWindow = {
    RTC: { rooms: window.RTC.rooms, getController: () => null, startB: async options => { started.push(options.room); return { pc: { connectionState: 'new' }, stop() {} }; } },
    Config: { subscribe: () => () => {} },
    Feeds: { captureFrontCalibrationFrame: () => new Promise(() => {}) },
    addEventListener() {}
  };
  vm.runInNewContext(readFileSync('app/calibration.js', 'utf8'), {
    window: phoneWindow, location: { pathname, search: '' }, console, setTimeout, clearTimeout,
    performance: { now: () => 0 },
    document: { createElement: () => ({ getContext: () => ({}), captureStream: () => stream, style: {}, setAttribute() {} }), body: { append() {} } }
  });
  assert.deepEqual(started, [], 'phone must not join calibration until Connect is pressed');
  phoneWindow.CalibrationPhone.connect();
  assert.deepEqual(started, [pathname === '/top.html' ? 'calibration-top' : 'calibration-front']);
  assert.equal(phoneWindow.Calibration.room('top'), 'calibration-top');
  assert.equal(phoneWindow.Calibration.room('front'), 'calibration-front');
}
console.log('PASS tokenless pages: workstation URLs/pane roles, normal top/index and PWA root bootstraps select all three pairings without tokens');
