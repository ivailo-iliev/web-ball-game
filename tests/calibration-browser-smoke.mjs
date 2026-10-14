// Real three-process Chromium E2E. No signaling fixture, camera footage or detection assertions.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resources, delay } from './calibration-e2e-resources.mjs';
import { chromium } from 'playwright';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const pages = {};
const token = `e2e-${process.pid}-${Date.now()}`;
const logs = [], errors = [];
const log = text => { logs.push(text); if (logs.length > 200) logs.shift(); };
const owned = resources(log);
const { browsers } = owned;
let origin, stage = 'Netlify/startup';
function inject(name) { if (process.env.E2E_FAIL_AT === name) throw new Error(`Injected ${name} failure`); }
async function wait(check, label, timeout = 90000) {
  stage = label;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(250); }
  throw new Error(`${label}: timed out after ${timeout}ms`);
}
async function signal(room, role) {
  const response = await fetch(`${origin}/.netlify/functions/signal-read?role=${role}${room ? `&room=${room}` : ''}`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200, `${stage}: signal-read HTTP status`);
  return response.json();
}
// Observe production calls/channels without altering options, SDP, transport or handlers.
function observe() {
  window.e2e = { calls: [], received: [] };
  let rtc;
  Object.defineProperty(window, 'RTC', { configurable: true, get: () => rtc, set(value) {
    rtc = value;
    for (const name of ['startA', 'startB']) {
      const original = value[name];
      value[name] = async function(options = {}) {
        const call = { name, room: options.room ?? 'gameplay', controller: null };
        window.e2e.calls.push(call);
        const controller = await original.call(this, options);
        call.controller = controller;
        return controller;
      };
    }
  } });
  const watchChannel = channel => channel.addEventListener('message', event => window.e2e.received.push(String(event.data)));
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener('datachannel', e => watchChannel(e.channel));
    }
    createDataChannel(...args) {
      const channel = super.createDataChannel(...args); watchChannel(channel); return channel;
    }
  };
  // No physical/synthetic camera is needed: production calibration.phone already
  // creates its minimal 2x2 blank canvas video track for negotiation.
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error('E2E: camera intentionally unavailable'); };
}
const room = source => `calibration-${token}-${source}`;
const pane = source => pages.laptop.frames().find(frame => frame.url().includes(`source=${source}`));
async function ready(source) {
  await wait(async () => {
    const frame = pane(source);
    return !!frame && await frame.evaluate(() => !!window.Config && !!document.querySelector('#teamA') && !document.querySelector('#teamA').disabled).catch(() => false);
  }, `Laptop↔${source}/data-channel state snapshot and enabled UI`);
}
async function connected() {
  stage = 'All three links/independent peer identity and state';
  for (const source of ['top', 'front']) {
    assert.equal(await pages[source].evaluate(room => {
      const gameplay = e2e.calls.filter(call => call.room === 'gameplay');
      const calibration = e2e.calls.findLast(call => call.room === room);
      return gameplay.length === 1 && gameplay[0].controller?.pc?.connectionState === 'connected'
        && calibration?.controller?.pc?.connectionState === 'connected'
        && gameplay[0].controller.pc !== calibration.controller.pc;
    }, room(source)), true, `${source}: distinct live gameplay/calibration peers (no gameplay restart)`);
    assert.equal(await pane(source).evaluate(() => e2e.calls.findLast(call => call.name === 'startA')?.controller?.channel?.readyState), 'open', `Laptop↔${source}: data channel open`);
  }
}
async function gameplay(label) {
  stage = `Top↔Front/${label}`;
  for (const bit of ['0', '1']) {
    const before = await pages.front.evaluate(() => window.e2e.received.length);
    assert.equal(await pages.top.evaluate(bit => window.RTC.send(bit), bit), true, `${stage}: RTC.send(${bit})`);
    await wait(() => pages.front.evaluate(({ before, bit }) => window.e2e.received.slice(before).includes(bit), { before, bit }), `${stage}/receive ${bit}`, 10000);
  }
  console.log(`PASS Top↔Front: 0/1 received (${label})`);
}
async function settings(source, color) {
  stage = `Laptop↔${source}/configuration ${color}`;
  const other = source === 'top' ? 'front' : 'top';
  const before = await pages[other].evaluate(() => ({ config: Config.snapshot(), storage: { ...localStorage } }));
  const receivedBefore = await pane(source).evaluate(() => e2e.received.length);
  await pane(source).selectOption('#teamA', color);
  await wait(() => pages[source].evaluate(color => cfg.teamA === color && localStorage.getItem('teamA') === JSON.stringify(color), color), `${stage}/phone localStorage`, 10000);
  await wait(() => pane(source).evaluate(({ color, before }) => cfg.teamA === color && e2e.received.slice(before).some(text => {
    const message = JSON.parse(text); return message.type === 'calibration-state' && message.values.teamA === color;
  }), { color, before: receivedBefore }), `${stage}/acknowledged state`, 10000);
  // Allow any accidentally misrouted asynchronous patch time to arrive.
  await delay(500);
  assert.deepEqual(await pages[other].evaluate(() => ({ config: Config.snapshot(), storage: { ...localStorage } })), before, `${stage}: wrong phone changed`);
  console.log(`PASS Laptop↔${source}: UI patch persisted/acknowledged; ${other} unchanged`);
}
async function disconnectReconnect(source) {
  stage = `Laptop↔${source}/disconnect`;
  const frame = pane(source), url = frame.url();
  const previousOffer = (await signal(room(source), 'b')).offer.sdp;
  // Remove only this laptop participant. Phone and its gameplay peer stay alive.
  await frame.goto('about:blank');
  await pages[source].evaluate(room => {
    const call = window.e2e.calls.findLast(call => call.room === room);
    if (!call?.controller?.pc) throw new Error('Missing calibration controller');
    window.e2e.reconnectStream = new MediaStream(call.controller.pc.getSenders().map(sender => sender.track).filter(Boolean));
    call.controller.stop();
    if (call.controller.pc.connectionState !== 'closed') throw new Error('Calibration peer did not close');
  }, room(source));
  const other = source === 'top' ? 'front' : 'top';
  await gameplay(`${source} calibration disconnected`);
  await settings(other, source === 'top' ? 'yellow' : 'green');
  await frame.goto(url);
  await wait(async () => {
    const offer = (await signal(room(source), 'b')).offer;
    return !!offer && offer.sdp !== previousOffer;
  }, `Laptop↔${source}/fresh reconnect offer`);
  await pages[source].evaluate(({ token, source }) => {
    window.e2e.reconnected = Calibration.link({ token, source, stream: window.e2e.reconnectStream });
  }, { token, source });
  await ready(source);
  await connected();
  await settings(source, source === 'top' ? 'blue' : 'red');
  await gameplay(`${source} calibration reconnected`);
}
async function diagnostics() {
  console.error(`FAIL ${stage}`);
  for (const [name, page] of Object.entries(pages)) for (const frame of page.frames()) {
    console.error(name, frame.url(), await frame.evaluate(() => ({
      text: document.body?.innerText.slice(0, 1500),
      calls: window.e2e?.calls.map(({ name, room, controller }) => ({ name, room, state: controller?.pc?.connectionState, ice: controller?.pc?.iceConnectionState, signaling: controller?.pc?.signalingState, channel: controller?.channel?.readyState })),
      received: window.e2e?.received, storage: { ...localStorage }
    })).catch(error => ({ unavailable: error.message })));
  }
  for (const r of [undefined, room('top'), room('front')]) console.error('SIGNAL', r ?? 'gameplay', await signal(r, 'b').catch(error => error.message));
  console.error('Recent Netlify/browser output:\n' + logs.slice(-60).join('\n'));
}
try {
  origin = await owned.start();
  inject('startup');
  await wait(async () => {
    if (owned.exitCode() !== null) throw new Error(`Netlify exited ${owned.exitCode()}: ${logs.join('')}`);
    return fetch(`${origin}/top.html`, { signal: AbortSignal.timeout(1000) }).then(response => response.ok).catch(() => false);
  }, 'Netlify/static readiness');
  // Prove the real local Functions/Blobs read/write/reset path before any peers.
  stage = 'Netlify/Blobs round trip';
  const probe = `probe-${token}`;
  const cleanGameplay = await fetch(`${origin}/.netlify/functions/signal-reset`, { method: 'POST', signal: AbortSignal.timeout(10000), body: '{}' });
  assert.equal(cleanGameplay.status, 200, 'Reset existing local gameplay room');
  for (const [endpoint, body] of [['signal-reset', { room: probe }], ['signal-write', { room: probe, kind: 'offer', role: 'a', data: { type: 'offer', sdp: 'e2e-storage-probe' } }]]) {
    const response = await fetch(`${origin}/.netlify/functions/${endpoint}`, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, `${stage}: ${endpoint}`);
  }
  assert.equal((await signal(probe, 'b')).offer.sdp, 'e2e-storage-probe');
  assert.ok(!(await signal(undefined, 'b')).offer, 'Probe room leaked into gameplay');
  await fetch(`${origin}/.netlify/functions/signal-reset`, { method: 'POST', signal: AbortSignal.timeout(10000), body: JSON.stringify({ room: probe }) });
  assert.ok(!(await signal(probe, 'b')).offer);
  console.log('PASS Netlify: actual Functions and local Blobs round trip');
  for (const name of ['laptop', 'top', 'front']) {
    const browser = await owned.acquire(() => chromium.launch({ headless: true }));
    const context = await browser.newContext(); await context.addInitScript(observe);
    pages[name] = await context.newPage();
    pages[name].on('console', message => log(`${name}: ${message.text()}`));
    pages[name].on('request', request => {
      if (request.url().includes('/signal-write')) log(`${name} WRITE ${request.postData()}`);
    });
    pages[name].on('pageerror', error => { errors.push(`${name}: ${error.message}`); log(`${name} PAGEERROR: ${error.message}`); });
  }
  inject('browsers');
  assert.equal(new Set(browsers).size, 3);
  console.log('PASS Chromium: three independent browser instances');
  await pages.laptop.goto(`${origin}/calibrate.html?calibration=${token}`);
  await wait(async () => (await signal(room('top'), 'b')).offer && (await signal(room('front'), 'b')).offer, 'Laptop↔Top/Front/offers stored');
  await pages.top.goto(`${origin}/top.html?calibration=${token}`);
  // Gameplay B checks only once: respect the production offer-first bootstrap.
  await wait(async () => !!(await signal(undefined, 'b')).offer, 'Top↔Front/gameplay offer stored');
  await pages.front.goto(`${origin}/index.html?calibration=${token}`);
  await ready('top'); await ready('front');
  await wait(() => pages.top.evaluate(() => window.e2e.calls.some(call => call.room === 'gameplay' && call.controller?.channel?.readyState === 'open')), 'Top↔Front/gameplay channel open');
  await connected();
  await gameplay('all three links simultaneous');
  inject('assertion');
  await settings('top', 'red'); await settings('front', 'blue');
  await gameplay('both calibration patches');
  await disconnectReconnect('top'); await disconnectReconnect('front');
  await connected();
  await gameplay('final three simultaneous links');
  stage = 'All peers/uncaught page errors';
  assert.deepEqual(errors, []);
  console.log('PASS three-peer Netlify/WebRTC E2E');
} catch (error) {
  await diagnostics().catch(diagnostic => console.error('Diagnostics failed:', diagnostic.message));
  console.error(error); process.exitCode = 1;
} finally {
  try { await owned.cleanup(); }
  finally { owned.removeSignalHandlers(); }
}
