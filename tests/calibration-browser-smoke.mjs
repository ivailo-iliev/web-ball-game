// Real three-process Chromium E2E. No signaling fixture, camera footage or detection assertions.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resources, delay } from './calibration-e2e-resources.mjs';
import { chromium } from 'playwright';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const pages = {};
// Exercise the production fixed rooms via ordinary, tokenless page URLs.
const rooms = { gameplay: 'default', top: 'calibration-top', front: 'calibration-front' };
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
const room = source => rooms[source];
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
    assert.equal(await pages[source].evaluate(({ gameplayRoom, calibrationRoom }) => {
      const gameplay = RTC.getController(gameplayRoom);
      const calibration = RTC.getController(calibrationRoom);
      return !!gameplay?.pc && gameplay.pc.connectionState === 'connected'
        && !!calibration?.pc && calibration.pc.connectionState === 'connected'
        && gameplay.pc !== calibration.pc
        && gameplay.channel?.readyState === 'open' && calibration.channel?.readyState === 'open';
    }, { gameplayRoom: rooms.gameplay, calibrationRoom: room(source) }), true, `${source}: distinct live gameplay/calibration peers`);
    assert.equal(await pane(source).evaluate(() => RTC.getController(RTC.rooms[location.search.includes('source=top') ? 'top' : 'front'])?.channel?.readyState), 'open', `Laptop↔${source}: data channel open`);
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
async function reverseSettings(source, color) {
  stage = `${source} phone→Laptop/configuration ${color}`;
  const before = await pane(source).evaluate(() => ({ config: Config.snapshot(), storage: { ...localStorage } }));
  const receivedBefore = await pages[source].evaluate(() => e2e.received.length);
  await pages[source].selectOption('#teamA', color);
  await wait(() => pages[source].evaluate(color => cfg.teamA === color && localStorage.getItem('teamA') === JSON.stringify(color), color), `${stage}/phone UI state persisted`, 10000);
  await wait(() => pane(source).evaluate(({ color, before }) => cfg.teamA === color
    && localStorage.getItem('teamA') === JSON.stringify(color)
    && e2e.received.slice(before).some(text => {
      const message = JSON.parse(text); return message.type === 'calibration-state' && message.values.teamA === color;
    }), { color, before: receivedBefore }), `${stage}/laptop receives and persists phone config`, 10000);
  assert.notEqual((await pane(source).evaluate(() => Config.snapshot())).teamA, before.config.teamA, `${stage}: laptop config changed`);
  console.log(`PASS ${source} phone→Laptop: UI patch delivered and persisted on laptop`);
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
async function restartConnection(source, participant) {
  const target = source === 'gameplay' ? rooms.gameplay : room(source);
  const page = source === 'gameplay' ? (participant === 'peer' ? pages.front : pages.top) : pages[source];
  const before = await page.evaluate(room => {
    const ctrl = RTC.getController(room);
    return { state: Config.snapshot(), storage: { ...localStorage }, tracks: ctrl?.pc?.getSenders().map(sender => sender.track?.id).filter(Boolean) ?? [] };
  }, target);
  const prior = await signal(target, 'b');
  const priorGeneration = prior.generation;
  const priorOffer = prior.offer?.sdp;
  stage = `${target}/restart from ${participant}`;
  if (participant === 'peer') {
    if (source === 'gameplay') await page.getByRole('button', { name: 'Restart gameplay connection' }).click();
    else await page.getByRole('button', { name: `Restart ${source} calibration connection` }).click();
  } else {
    if (source === 'gameplay') await page.getByRole('button', { name: 'Restart gameplay connection' }).click();
    else await pane(source).getByRole('button', { name: `Restart ${source} calibration connection` }).click();
  }
  await wait(async () => {
    const signalState = await signal(target, 'b');
    const current = await page.evaluate(room => RTC.getController(room)?.pc?.connectionState, target);
    return signalState.generation !== priorGeneration && signalState.offer?.sdp && signalState.offer.sdp !== priorOffer && current === 'connected';
  }, `${stage}/new signaling generation and connected peer`);
  const currentGeneration = (await signal(target, 'b')).generation;
  assert.deepEqual(await page.evaluate(room => ({ state: Config.snapshot(), storage: { ...localStorage }, tracks: RTC.getController(room)?.pc?.getSenders().map(sender => sender.track?.id).filter(Boolean) ?? [] }), target), before,
    `${stage}: game/config/camera state preserved`);
  await delay(1500);
  assert.equal(await page.evaluate(async room => {
    const peer = RTC.getController(room)?.pc;
    await new Promise(resolve => setTimeout(resolve, 1500));
    return peer === RTC.getController(room)?.pc;
  }, target), true, `${stage}: no automatic reconnect loop`);
  assert.equal((await signal(target, 'b')).generation, currentGeneration, `${stage}: signaling generation stable after restart`);
  await connected();
  if (source !== 'gameplay') {
    const colors = { top: { peer: 'yellow', local: 'blue' }, front: { local: 'green', peer: 'red' } };
    await reverseSettings(source, colors[source][participant]);
  }
  await gameplay(`${target} restarted independently`);
  console.log(`PASS ${target}: independent restart initiated by ${participant}; state preserved`);
}
async function diagnostics() {
  console.error(`FAIL ${stage}`);
  for (const [name, page] of Object.entries(pages)) for (const frame of page.frames()) {
    console.error(name, frame.url(), await frame.evaluate(() => ({
      text: document.body?.innerText.slice(0, 1500),
      peers: window.RTC?.rooms && Object.fromEntries(Object.entries(window.RTC.rooms).map(([name, room]) => {
        const controller = window.RTC.getController(room);
        return [name, { role: controller?.role, state: controller?.status, connection: controller?.pc?.connectionState, ice: controller?.pc?.iceConnectionState, signaling: controller?.pc?.signalingState, channel: controller?.channel?.readyState, error: controller?.error?.message ?? controller?.error }];
      })),
      received: window.e2e?.received, storage: { ...localStorage }
    })).catch(error => ({ unavailable: error.message })));
  }
  for (const r of [undefined, room('top'), room('front')]) {
    const state = await signal(r, 'b').catch(error => error.message);
    console.error('SIGNAL', r ?? 'gameplay', typeof state === 'string' ? state : {
      generation: state.generation, offer: !!state.offer, answer: !!state.answer, candidates: state.candidates?.length ?? 0
    });
  }
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
  const probe = `probe-${process.pid}-${Date.now()}`;
  const cleanGameplay = await fetch(`${origin}/.netlify/functions/signal-reset`, { method: 'POST', signal: AbortSignal.timeout(10000), body: '{}' });
  assert.equal(cleanGameplay.status, 200, 'Reset existing local gameplay room');
  const probeReset = await fetch(`${origin}/.netlify/functions/signal-reset`, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: probe }) });
  assert.equal(probeReset.status, 200, `${stage}: probe reset`);
  const probeGeneration = (await probeReset.json()).generation;
  const probeWrite = await fetch(`${origin}/.netlify/functions/signal-write`, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: probe, generation: probeGeneration, kind: 'offer', role: 'a', data: { type: 'offer', sdp: 'e2e-storage-probe' } }) });
  assert.equal(probeWrite.status, 200, `${stage}: signal-write`);
  assert.equal((await signal(probe, 'b')).offer.sdp, 'e2e-storage-probe');
  assert.ok(!(await signal(undefined, 'b')).offer, 'Probe room leaked into gameplay');
  const probeCleanup = await fetch(`${origin}/.netlify/functions/signal-reset`, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: probe }) });
  assert.equal(probeCleanup.status, 200);
  const staleWrite = await fetch(`${origin}/.netlify/functions/signal-write`, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: probe, generation: probeGeneration, kind: 'offer', role: 'a', data: { type: 'offer', sdp: 'stale-e2e-offer' } }) });
  assert.equal(staleWrite.status, 409, 'Old-generation writes cannot repopulate a reset room');
  assert.ok(!(await signal(probe, 'b')).offer);
  assert.ok(!(await signal(undefined, 'b')).offer, 'Probe room leaked into gameplay');
  console.log('PASS Netlify: actual Functions and local Blobs round trip; stale writes isolated by generation');
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
  await pages.laptop.goto(`${origin}/calibrate.html`);
  await wait(async () => (await signal(room('top'), 'b')).offer && (await signal(room('front'), 'b')).offer, 'Laptop↔Top/Front/offers stored');
  await pages.top.goto(`${origin}/top.html`);
  // Gameplay B checks only once: respect the production offer-first bootstrap.
  await wait(async () => !!(await signal(undefined, 'b')).offer, 'Top↔Front/gameplay offer stored');
  await pages.front.goto(`${origin}/index.html`);
  await ready('top'); await ready('front');
  await wait(() => pages.top.evaluate(() => RTC.getController(RTC.rooms.gameplay)?.channel?.readyState === 'open'), 'Top↔Front/gameplay channel open');
  await connected();
  await gameplay('all three links simultaneous');
  inject('assertion');
  await settings('top', 'red'); await settings('front', 'blue');
  await gameplay('both calibration patches');
  await restartConnection('top', 'peer');
  await restartConnection('front', 'local');
  await restartConnection('gameplay', 'peer');
  await settings('top', 'yellow');
  await settings('front', 'green');
  await gameplay('bidirectional configuration after reconnection');
  await restartConnection('top', 'local');
  await restartConnection('front', 'peer');
  await restartConnection('gameplay', 'local');
  await settings('top', 'blue'); await settings('front', 'red');
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
