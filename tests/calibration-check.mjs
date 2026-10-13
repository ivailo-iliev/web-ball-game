// Deterministic checks using Node assert/vm and the existing TypeScript compiler.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

export function signalFixture() {
  const blobs = new Map();
  const store = {
    list: async ({ prefix }) => ({ blobs: [...blobs.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }),
    delete: async key => blobs.delete(key),
    get: async key => blobs.get(key) || null,
    setJSON: async (key, value) => blobs.set(key, value)
  };
  const compile = (file, inject) => {
    const source = readFileSync(file, 'utf8').replace(/^import .*$/gm, '');
    const output = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 });
    const sandbox = { exports: {}, Request, Response, URL, crypto: globalThis.crypto, ...inject };
    vm.runInNewContext(output, sandbox, { filename: file });
    return sandbox.exports;
  };
  const { roomBase } = compile('netlify/lib/room.ts', {});
  const handlers = Object.fromEntries(['read', 'write', 'reset'].map(name => [name,
    compile(`netlify/functions/signal-${name}.mts`, { getStore: () => store, roomBase }).default]));
  return { handlers, blobs, roomBase };
}

async function check() {
  const { handlers, blobs, roomBase } = signalFixture();
  assert.equal(roomBase(undefined), 'room/default');
  for (const room of ['', '../default', 'a/b', 'x'.repeat(97), 123, {}, null]) assert.equal(roomBase(room), null);
  const request = (name, body, query = '') => handlers[name](new Request(`https://test/signal-${name}${query}`, {
    method: name === 'read' ? 'GET' : 'POST', ...(name === 'read' ? {} : { body: JSON.stringify(body) })
  }), {});
  for (const room of [undefined, 'calibration-demo-top', 'calibration-demo-front']) {
    assert.equal((await request('write', { room, kind: 'offer', data: { type: 'offer', sdp: 'fixture' } })).status, 200);
  }
  assert.equal(blobs.size, 3);
  await request('reset', { room: 'calibration-demo-top' });
  assert.equal(blobs.size, 2);
  assert.ok(blobs.has('room/default/offer.json'));
  assert.ok(blobs.has('room/calibration-demo-front/offer.json'));
  assert.equal((await request('read', null, '?role=a&room=../default')).status, 400);
  assert.equal((await request('write', { room: '../default', kind: 'offer', data: {} })).status, 400);
  assert.equal((await request('reset', { room: '' })).status, 400);
  assert.equal((await handlers.write(new Request('https://test', { method: 'POST', body: '{' }), {})).status, 400);
  assert.equal((await request('write', { kind: 'candidate', role: '../x', data: {} })).status, 400);
  const original = await (await request('read', null, '?role=a')).json();
  assert.equal(original.offer.sdp, 'fixture');
  console.log('PASS signaling: default compatibility, room isolation/reset, invalid inputs');

  const storage = new Map();
  const window = {};
  const sandbox = { window, localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    console, location: { search: '', pathname: '/index.html' }, URLSearchParams, URL, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  const run = file => vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
  run('app/config.js');
  // Read the authoritative defaults without running its DOM-binding side effects.
  vm.runInContext(readFileSync('app/setup.js', 'utf8').replace('  Setup.bind();', ''), sandbox);
  const defaults = window.CONFIG_DEFAULTS;
  const config = window.createConfig(defaults); config.load();
  const cached = config.get();
  let changes = 0;
  config.subscribe(() => changes++);
  config.save('teamA', 'red');
  assert.equal(config.get(), cached);
  assert.equal(cached.colorA, 0);
  assert.equal(changes, 1);
  const memory = window.createConfig(defaults, { memory: true }); memory.load(); memory.save('teamA', 'blue');
  assert.equal(storage.get('teamA'), '"red"');
  assert.equal(memory.get().colorA, 2);
  assert.equal(config.get().colorA, 0);
  run('app/calibration.js');
  const C = window.Calibration;
  assert.equal(C.room('demo', 'top'), 'calibration-demo-top');
  assert.notEqual(C.room('demo', 'top'), C.room('demo', 'front'));
  assert.throws(() => C.room('../default', 'top'));
  assert.ok(C.values(config.snapshot()));
  const decode = v => C.decode(JSON.stringify(v), 'calibration-config');
  for (const values of [{ unknown: 1 }, { zoom: 0 }, { teamA: 'constructor' }, { camW: Infinity },
    { domThr: [0, 1] }, { frontRect: { x: 0, y: 0, w: -1, h: 1 } }, { topMode: 0.5 }, { zoom: '' },
    { url: 'javascript:alert(1)' }, JSON.parse('{"__proto__":{}}')]) {
    assert.equal(decode({ type: 'calibration-config', values }), null);
  }
  assert.equal(C.decode('{', 'calibration-config'), null);
  assert.equal(decode({ type: 'calibration-state', values: { zoom: 1 } }), null);
  assert.equal(decode({ type: 'calibration-config', values: { zoom: 1 }, extra: true }), null);
  assert.equal(decode({ type: 'calibration-config', values: { zoom: '1.25' } }).zoom, 1.25);
  console.log('PASS Config: persistence/cache identity, independent memory instances; payload allowlist/bounds/envelopes');

  for (const file of readdirSync('app').filter(file => file.endsWith('.js'))) new vm.Script(readFileSync(`app/${file}`, 'utf8'), { filename: file });
  for (const html of ['index.html', 'top.html', 'calibrate.html', 'calibration-pane.html']) {
    for (const [, src] of readFileSync(html, 'utf8').matchAll(/<script[^>]+src="([^"]+)"/g)) assert.ok(readFileSync(src).length);
  }
  for (const html of ['index.html', 'top.html']) {
    const text = readFileSync(html, 'utf8');
    assert.equal((text.match(/app\/calibration.js/g) || []).length, 1);
    assert.ok(text.indexOf('app/setup.js') < text.indexOf('app/calibration.js'));
  }
  assert.ok(!readFileSync('app/calibration-pane.js', 'utf8').includes('getUserMedia'));
  console.log('PASS static smoke: all classic scripts parse, all page script assets resolve, phone bootstrap order');
}
if (process.argv[1]?.endsWith('calibration-check.mjs')) await check();
