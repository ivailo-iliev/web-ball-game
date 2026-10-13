// Optional real-browser smoke driver, not a test framework. Uses synthetic cameras
// and the actual signal handlers with an in-memory Blobs fixture (not Netlify).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { signalFixture } from './calibration-check.mjs';

const { handlers } = signalFixture();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    const name = url.pathname.match(/^\/\.netlify\/functions\/signal-(read|write|reset)$/)?.[1];
    if (name) {
      let body = ''; for await (const chunk of req) body += chunk;
      const response = await handlers[name](new Request(url, {
        method: req.method, ...(req.method === 'GET' ? {} : { body })
      }), {});
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text()); return;
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (file.includes('..')) throw new Error('Invalid path');
    let data = await readFile(file);
    if (file === 'app/webrtc.js') data = Buffer.concat([data, Buffer.from(`
      for (const name of ['startA', 'startB']) {
        const start = RTC[name]; RTC[name] = opts => start({ ...opts, directOnly: true });
      }
    `)]); // Local fixture: do not wait for unreachable public STUN servers.
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'text/plain' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: [
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--enable-unsafe-webgpu', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--enable-features=Vulkan', '--disable-vulkan-surface'
] });
const errors = [];
try {
  const seen = new Set();
  const watch = page => page.on('console', message => {
    const key = message.text();
    if (!seen.has(key)) { seen.add(key); console.error('BROWSER', page.url(), key); }
  });
  const laptop = await browser.newContext();
  laptop.on('page', watch);
  await laptop.addInitScript(() => {
    window.cameraRequests = 0;
    navigator.mediaDevices.getUserMedia = () => { window.cameraRequests++; throw new Error('Workstation must not acquire a camera'); };
  });
  const workstation = await laptop.newPage();
  workstation.on('pageerror', e => errors.push('workstation: ' + e.message));
  await workstation.goto(origin + '/calibrate.html?calibration=smoke');
  await workstation.waitForFunction(() => document.querySelectorAll('iframe').length === 2);
  const pane = source => workstation.frames().find(f => f.url().includes(`source=${source}`));
  await workstation.waitForTimeout(1500);
  for (const source of ['top', 'front']) {
    const f = pane(source);
    await f.waitForFunction(() => window.Config && window.Calibration);
    // Track actual existing detector execution, including GPU success/failure.
    await f.evaluate(() => {
      window.detectorRuns = { calls: 0, successful: 0, errors: [] };
      const detect = window.GPU.detect;
      window.GPU.detect = async args => {
        window.detectorRuns.calls++;
        try { const result = await detect(args); window.detectorRuns.successful++; return result; }
        catch (e) { if (window.detectorRuns.errors.length < 3) window.detectorRuns.errors.push(e.message); throw e; }
      };
    });
  }
  const phones = {};
  for (const source of ['top', 'front']) {
    const context = await browser.newContext();
    context.on('page', watch);
    await context.addInitScript(() => {
      window.captureTimes = [];
      window.cameraRequests = [];
      const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = constraints => { window.cameraRequests.push(constraints); return acquire(constraints); };
      const requestFrame = CanvasCaptureMediaStreamTrack.prototype.requestFrame;
      CanvasCaptureMediaStreamTrack.prototype.requestFrame = function () {
        window.captureTimes.push(performance.now());
        return requestFrame.call(this);
      };
      for (const [key, value] of Object.entries({ camW: 320, camH: 240, topH: 240, frontH: 120,
        topRect: { x: 0, y: 0, w: 320, h: 240 }, frontRect: { x: 0, y: 0, w: 160, h: 120 } })) localStorage.setItem(key, JSON.stringify(value));
    });
    const phone = await context.newPage();
    phone.on('pageerror', e => errors.push(source + ': ' + e.message));
    await phone.goto(origin + (source === 'top' ? '/top.html' : '/index.html') + '?calibration=smoke');
    if (source === 'top') await phone.click('#start');
    phones[source] = phone;
  }
  for (const source of ['top', 'front']) {
    const f = pane(source);
    await f.waitForFunction(() => document.querySelector('#remoteFeed').videoWidth > 2 && !document.querySelector('#teamA').disabled, { timeout: 30000 });
    assert.equal(await f.evaluate(() => window.cfg.camW), 320);
    console.log('PASS browser: ' + source + ' real WebRTC remote stream and seeded matching controls');
  }
  await pane('top').selectOption('#teamA', 'red');
  await phones.top.waitForFunction(() => window.cfg.teamA === 'red' && localStorage.getItem('teamA') === '"red"');
  assert.equal(await phones.front.evaluate(() => window.cfg.teamA), 'green');
  await pane('front').locator('#frontZoom').fill('1.25');
  await phones.front.waitForFunction(() => window.cfg.zoom === 1.25 && document.querySelector('#frontZoom').value === '1.25');
  assert.equal(await phones.top.evaluate(() => window.cfg.zoom), 1);
  // Phone-origin edits must return through the state envelope and refresh the pane.
  await phones.front.selectOption('#teamA', 'yellow');
  await pane('front').waitForFunction(() => document.querySelector('#teamA').value === 'yellow');
  console.log('PASS browser: independent control patches persist/apply on phones; phone edits refresh pane');
  for (const source of ['top', 'front']) {
    await pane(source).waitForFunction(() => window.detectorRuns.successful > 0, { timeout: 15000 });
    const stats = await pane(source).evaluate(() => window.detectorRuns);
    assert.ok(stats.calls > 0);
    assert.ok(stats.successful > 0, JSON.stringify(stats));
    console.log(`PASS browser: ${source} existing WebGPU detector successful (${stats.successful} runs)`);
  }
  await workstation.waitForTimeout(2100);
  for (const source of ['top', 'front']) {
    const times = await phones[source].evaluate(() => window.captureTimes);
    assert.ok(times.length >= 3);
    const cameras = await phones[source].evaluate(() => window.cameraRequests);
    assert.equal(cameras.length, 1);
    assert.equal(cameras[0].video.frameRate.ideal, 60);
    assert.equal(await pane(source).evaluate(() => window.cameraRequests), 0);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 495);
  }
  console.log('PASS browser: independent canvas copies have <=2 FPS capture cadence; only one unchanged 60 FPS camera request per phone, none on workstation');
  // Closing top must not stop the front connection.
  await phones.top.close();
  await pane('front').locator('#frontZoom').fill('1.5');
  await phones.front.waitForFunction(() => window.cfg.zoom === 1.5);
  console.log('PASS browser: top disconnect does not stop front configuration transport');
  // A no-query pair keeps the original default room, UI, camera and gameplay DC.
  const normalContext = await browser.newContext();
  normalContext.on('page', watch);
  await normalContext.addInitScript(() => {
    for (const [key, value] of Object.entries({ camW: 320, camH: 240 })) localStorage.setItem(key, JSON.stringify(value));
  });
  const top = await normalContext.newPage();
  top.on('pageerror', e => errors.push('normal top: ' + e.message));
  await top.goto(origin + '/top.html');
  await top.waitForFunction(() => document.querySelector('#state').textContent.includes('sent: offer'));
  const front = await normalContext.newPage();
  front.on('pageerror', e => errors.push('normal front: ' + e.message));
  await front.goto(origin + '/index.html');
  await top.waitForFunction(() => !document.querySelector('#b0').disabled);
  await top.click('#start');
  await top.waitForFunction(() => document.querySelector('#info').textContent.includes('Running'));
  assert.equal(await top.locator('#calibrationStatus').count(), 0);
  assert.equal(await front.locator('#calibrationStatus').count(), 0);
  assert.equal(await front.locator('#launcher button').count(), 9);
  await front.evaluate(() => {
    const handle = Controller.handleBit;
    Controller.handleBit = bit => { window.lastGameplayBit = bit; return handle(bit); };
  });
  await top.click('#b0');
  await front.waitForFunction(() => window.lastGameplayBit === 0);
  console.log('PASS browser: no-query pages retain default gameplay DC, local top detector and original launcher; no calibration initialization');
  assert.deepEqual(errors, []);
  console.log('PASS browser: no uncaught page errors, workstation camera acquisition forbidden');
} catch (err) {
  console.error('Browser smoke failure:', err.message, 'page errors:', errors);
  for (const context of browser.contexts()) for (const page of context.pages()) {
    for (const frame of page.frames()) console.error(frame.url(), await frame.evaluate(() => ({
      text: document.body.innerText.slice(0, 1800), video: Array.from(document.querySelectorAll('video')).map(v => ({ width: v.videoWidth, ready: v.readyState })),
      detector: window.detectorRuns, calibration: typeof window.Calibration, preview: !!window.CalibrationPreview, search: location.search, scripts: Array.from(document.scripts).map(s => s.src)
    })).catch(() => null));
  }
  throw err;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
