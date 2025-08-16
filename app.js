// app.js – dual-camera WebGPU detection with throttled setup and one-shot front processing
// ------------------------------------------------------------------------------
// * Continuous WebGPU detection on MJPEG "top" feed
// * One-shot WebGPU detection on device-camera "front" feed upon impact
// * Identical pipeline in setup (throttled) and live (triggered)

(function () {
  'use strict';

/* ---------------- CONSTANTS ---------------- */
// ——————— CONSTANTS ———————
// top-camera MJPEG feed (over Wi-Fi)
// moved constants into Config
const FLAG_PREVIEW = GPUShared.FLAGS.PREVIEW;   // bit 0 – preview
const FLAG_TEAM_A_ACTIVE = GPUShared.FLAGS.TEAM_A;   // bit 1 – team A
const FLAG_TEAM_B_ACTIVE = GPUShared.FLAGS.TEAM_B;   // bit 2 – team B

const TOP_MODE_MJPEG = 'mjpeg';
const TOP_MODE_WEBRTC = 'webrtc';

// front-camera (device camera)

/* HSV ranges per team */
// const COLOR_TABLE = {
//   red: [[0.00, 0.5, 0.7], [0.10, 1.00, 1.00]],
//   yellow: [[0.10, 0.5, 0.5], [0.20, 1.00, 1.00]],
//   blue: [[0.50, 0.4, 0.4], [0.70, 1.00, 1.00]],
//   green: [[0.70, 0.2, 0.2], [0.90, 1.00, 1.00]],
// };
/* Flat HSV table: [loH,loS,loV, hiH,hiS,hiV] × 4 teams */
const TEAM_INDICES = { red: 0, yellow: 1, blue: 2, green: 3 };
const COLOR_TABLE = new Float32Array([
  /* 🔴 */ 0.00 , 0.6 , 0.35 , 0.1 , 1 , 1 ,
  /* 🟡 */ 0.05 , 0.7 , 0.40 , 0.2 , 1 , 1 ,
  /* 🔵 */ 0.50 , 0.3 , 0.20 , 0.7 , 1 , 1 ,
  /* 🟢 */ 0.70 , 0.6 , 0.25 , 0.9 , 1 , 1 
]);
const savedCT = localStorage.getItem('COLOR_TABLE');
if (savedCT) {
  try {
    const arr = JSON.parse(savedCT);
    if (Array.isArray(arr) && arr.length === COLOR_TABLE.length) {
      COLOR_TABLE.set(arr.map(Number));
    }
  } catch (e) {}
}
const COLOR_EMOJI = {
  red: '🔴',
  yellow: '🟡',
  green: '🟢',
  blue: '🔵'
};
const { hsvRange, hsvRangeF16 } = GPUShared.createColorHelpers(TEAM_INDICES, COLOR_TABLE);

const DEFAULTS = {
  TOP_W: 640,
  TOP_H: 480,
  FRONT_W: 1280,
  FRONT_H: 590,
  TOP_MIN_AREA: 400,
  FRONT_MIN_AREA: 8000,
  url:    "http://192.168.43.1:8080/video",
  teamA:  "green",
  teamB:  "blue",
  polyT:  [],
  polyF:  [],
  zoom:   1.0,
  topH:   160,
  frontH: 220,
  topMode: TOP_MODE_WEBRTC
};

const Config = createConfig(DEFAULTS);
Config.load({ teamIndices: TEAM_INDICES, hsvRangeF16 });

const PreviewGfx = (() => {
  const cfg = Config.get();
  let ctxTop2d, ctxFront2d, ctxTopGPU, ctxFrontGPU;

  function ensure2d() {
    if (!ctxTop2d) ctxTop2d = $('#topOv')?.getContext('2d');
    if (!ctxFront2d) ctxFront2d = $('#frontOv')?.getContext('2d');
  }

  function ensureGPU(device) {
    if (!device) return;
    if (!ctxTopGPU) {
      const c = $('#topTex');
      if (c && typeof c.getContext === 'function') {
        try {
          ctxTopGPU = c.getContext('webgpu');
          ctxTopGPU?.configure({ device, format: 'rgba8unorm' });
        } catch (err) {
          console.log('Top canvas WebGPU init failed', err);
          ctxTopGPU = null;
        }
      }
    }
    if (!ctxFrontGPU) {
      const c = $('#frontTex');
      if (c && typeof c.getContext === 'function') {
        try {
          ctxFrontGPU = c.getContext('webgpu');
          ctxFrontGPU?.configure({ device, format: 'rgba8unorm' });
        } catch (err) {
          console.log('Front canvas WebGPU init failed', err);
          ctxFrontGPU = null;
        }
      }
    }
  }

  function clear() {
    ensure2d();
    if (ctxTop2d) ctxTop2d.clearRect(0, 0, ctxTop2d.canvas.width, ctxTop2d.canvas.height);
    if (ctxFront2d) ctxFront2d.clearRect(0, 0, ctxFront2d.canvas.width, ctxFront2d.canvas.height);
  }

  function drawROI(poly, color, which) {
    ensure2d();
    const ctx = which === 'front' ? ctxFront2d : ctxTop2d;
    if (!ctx) return;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (poly.length !== 4) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(...poly[0]);
    poly.slice(1).forEach(p => ctx.lineTo(...p));
    ctx.closePath();
    ctx.stroke();
  }

  function drawHit(hit) {
    ensure2d();
    if (!ctxFront2d) return;
    ctxFront2d.fillStyle = hit.team;
    const px = hit.x * cfg.FRONT_W, py = hit.y * cfg.FRONT_H;
    ctxFront2d.beginPath();
    ctxFront2d.arc(px, py, 8, 0, Math.PI * 2);
    ctxFront2d.fill();
  }

  function drawMask(enc, pipelines, feed, device, which) {
    ensureGPU(device);
    const ctx = which === 'front' ? ctxFrontGPU : ctxTopGPU;
    if (!ctx) return;
    const view = ctx.getCurrentTexture().createView();
    GPUShared.drawMaskTo(enc, pipelines, feed, view);
  }

  return { drawMask, drawROI, drawHit, clear };
})();


const Setup = (() => {
  const cfg = Config.get();
  const detectionUI = `
  <div class=cam id=topCam>
    <canvas id=topTex width=${cfg.TOP_W} height=${cfg.TOP_H}></canvas>
    <canvas id=topOv class=overlay width=${cfg.TOP_W} height=${cfg.TOP_H}></canvas>
  </div>
  <div class=cam id=frontCam>
   <video id=vid autoplay playsinline style="display: none;"></video>
   <canvas id="frontTex" width=${cfg.FRONT_W} height=${cfg.FRONT_H}></canvas>
   <canvas id=frontOv  class=overlay width=${cfg.FRONT_W} height=${cfg.FRONT_H}></canvas>
  </div>
  <div id=cfg>
    <span>
      <button id=btnTop>⇥</button>
      <button id=btnFront>⛶</button>
      <button id=btnBoth>🀱</button>
      <button onclick="location.reload()">⟳</button>
      <button id=btnStart>►</button>
    </span>
    <label for=frontZoom>🔍 <input id=frontZoom type=number style="width:3ch"></label>
    <label for=topMinInp>⚫ <input id=topMinInp   type=number min=0 step=25 style="width:6ch"></label>
    <label for=topHInp>↕️ <input id=topHInp   type=number min=10 max=${cfg.TOP_H} step=1></label>
    <label for=frontMinInp>⚫ <input id=frontMinInp type=number min=0 step=100  style="width:6ch"></label>
    <label for=frontHInp>↕️ <input id=frontHInp type=number min=10 max=${cfg.FRONT_H} step=1></label>
    <label for=topMode>📡 <select id=topMode>
      <option value="${TOP_MODE_WEBRTC}">WebRTC</option>
      <option value="${TOP_MODE_MJPEG}">MJPEG</option>
    </select></label>
    <label for=topUrl>🔗 <input id=topUrl size=28><span id=urlWarn></span></label>
    <label for=teamA>🅰️ <select id=teamA>${Object.entries(COLOR_EMOJI).map(([c, e]) => `<option value="${c}">${e}</option>`).join('')}</select></label>
    <label for=teamB>🅱️ <select id=teamB>${Object.entries(COLOR_EMOJI).map(([c, e]) => `<option value="${c}">${e}</option>`).join('')}</select></label>
    <label>HSV <span id=teamAThresh></span></label>
  </div>`;

  function bind() {
    $('#configScreen').insertAdjacentHTML('beforeend', detectionUI);
    const urlI = $('#topUrl');
    const urlWarn = $('#urlWarn');
    const selMode = $('#topMode');
    const selA = $('#teamA');
    const selB = $('#teamB');
    const thCont = $('#teamAThresh');
    const thInputs = [];
    for (let i = 0; i < 6; i++) {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = '0';
      inp.max = '1';
      inp.step = '0.05';
      inp.style.width = '4ch';
      inp.id = `threshA${i}`;
      thCont?.appendChild(inp);
      thInputs.push(inp);
      // Use the `input` event so spinner buttons and manual typing
      // both immediately update the threshold values and persist them.
      inp.addEventListener('input', e => {
        const base = TEAM_INDICES[cfg.teamA] * 6 + i;
        COLOR_TABLE[base] = parseFloat(e.target.value);
        localStorage.setItem('COLOR_TABLE', JSON.stringify(Array.from(COLOR_TABLE)));
        cfg.f16Ranges[cfg.teamA] = hsvRangeF16(cfg.teamA);
      });
    }
    selMode.value = cfg.topMode;
    selMode.onchange = e => {
      cfg.topMode = e.target.value;
      Config.save('topMode', cfg.topMode);
    };

    initNumberSpinners();
    function updateThreshInputs() {
      const base = TEAM_INDICES[cfg.teamA] * 6;
      for (let i = 0; i < 6; i++) thInputs[i].value = COLOR_TABLE[base + i];
    }
    const topOv = $('#topOv');
    const frontOv = $('#frontOv');
    const btnStart = $('#btnStart');
    const btnTop   = $('#btnTop');
    const btnFront = $('#btnFront');
    const btnBoth  = $('#btnBoth');

    const cfgScreen = $('#configScreen');
    btnStart?.addEventListener('click', () => snapTo(1));
    btnTop?.addEventListener('click', () => cfgScreen.className = 'onlyTop');
    btnFront?.addEventListener('click', () => cfgScreen.className = 'onlyFront');
    btnBoth?.addEventListener('click', () => cfgScreen.className = '');

  const topROI = { y: 0, h: cfg.topH };

  function drawPolyTop() { PreviewGfx.drawROI(cfg.polyT, 'lime', 'top'); }
  function drawPolyFront() { PreviewGfx.drawROI(cfg.polyF, 'aqua', 'front'); }

  function commitTop() {
    topROI.y = Math.min(Math.max(0, topROI.y), cfg.TOP_H - topROI.h);
    const { y, h } = topROI;
    cfg.polyT = [[0, y], [cfg.TOP_W, y], [cfg.TOP_W, y + h], [0, y + h]];
    Config.save('polyT', cfg.polyT);
    drawPolyTop();
  }

  function orderPoints(pts) {
    const arr = pts.map(p => [...p]);
    let tr = 0, bl = 0, mx = arr[0][0] - arr[0][1], mn = mx;
    arr.forEach((p, i) => {
      const v = p[0] - p[1];
      if (v > mx) { mx = v; tr = i; }
      if (v < mn) { mn = v; bl = i; }
    });
    const rem = [0, 1, 2, 3].filter(i => i !== tr && i !== bl);
    const [a, b] = rem;
    const sumA = arr[a][0] + arr[a][1], sumB = arr[b][0] + arr[b][1];
    const tl = sumA < sumB ? a : b;
    const br = rem.find(i => i !== tl);
    return [arr[tl], arr[tr], arr[br], arr[bl]];
  }

    if (cfg.polyT.length === 4) {
      const ys = cfg.polyT.map(p => p[1]);
      topROI.y = Math.min(...ys);
      topROI.h = Math.max(...ys) - topROI.y;
    }

    /* vertical drag on overlay */
    let dragY = null;
    topOv.style.touchAction = 'none';
    topOv.addEventListener('pointerdown', e => {
      if (!Controller.isPreview()) return;
      const r = topOv.getBoundingClientRect();
      dragY = (e.clientY - r.top) * cfg.TOP_H / r.height;
      topOv.setPointerCapture(e.pointerId);
    });
    topOv.addEventListener('pointermove', e => {
      if (dragY == null || !Controller.isPreview()) return;
      const r = topOv.getBoundingClientRect();
      const curY = (e.clientY - r.top) * cfg.TOP_H / r.height;
      topROI.y += curY - dragY;
      dragY = curY;
      commitTop();
    });
    topOv.addEventListener('pointerup', () => dragY = null);
    topOv.addEventListener('pointercancel', () => dragY = null);

    commitTop();

    (function () {
      const ASPECT = cfg.FRONT_W / cfg.FRONT_H;
      const MIN_W = 60;

      let roi = { x: 0, y: 0, w: cfg.frontH * ASPECT, h: cfg.frontH };
      if (cfg.polyF?.length === 4) {
        const xs = cfg.polyF.map(p => p[0]), ys = cfg.polyF.map(p => p[1]);
        roi.x = Math.min(...xs);
        roi.y = Math.min(...ys);
        roi.w = Math.max(...xs) - roi.x;
      }

      const fingers = new Map();
      let startRect, startDist, startMid;

      function commit() {
        roi.w = Math.max(MIN_W, roi.w);
        roi.w = roi.h * ASPECT;

        if (roi.w > cfg.FRONT_W) { roi.w = cfg.FRONT_W; roi.h = roi.w / ASPECT; }
        if (roi.h > cfg.FRONT_H) { roi.h = cfg.FRONT_H; roi.w = roi.h * ASPECT; }

        roi.x = Math.min(Math.max(0, roi.x), cfg.FRONT_W - roi.w);
        roi.y = Math.min(Math.max(0, roi.y), cfg.FRONT_H - roi.h);

        const x0 = Math.round(roi.x), y0 = Math.round(roi.y);
        const x1 = Math.round(roi.x + roi.w), y1 = Math.round(roi.y + roi.h);
        cfg.polyF = orderPoints([[x1, y0], [x0, y0], [x0, y1], [x1, y1]]);
        Config.save('polyF', cfg.polyF);
        drawPolyFront();
      }

      function toCanvas(e) {
        const r = frontOv.getBoundingClientRect();
        return {
          x: (e.clientX - r.left) * cfg.FRONT_W / r.width,
          y: (e.clientY - r.top) * cfg.FRONT_H / r.height
        };
      }

      frontOv.addEventListener('pointerdown', e => {
        if (!Controller.isPreview()) return;
        frontOv.setPointerCapture(e.pointerId);
        fingers.set(e.pointerId, toCanvas(e));

        if (fingers.size === 1) {
          startRect = { ...roi };
          startMid = { ...fingers.values().next().value };
        } else if (fingers.size === 2) {
          const [a, b] = [...fingers.values()];
          startDist = Math.hypot(b.x - a.x, b.y - a.y);
          startMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          startRect = { ...roi };
        }
      });

      frontOv.addEventListener('pointermove', e => {
        if (!fingers.has(e.pointerId) || !Controller.isPreview()) return;
        fingers.set(e.pointerId, toCanvas(e));

        if (fingers.size === 1) {
          const cur = [...fingers.values()][0];
          roi.x = startRect.x + (cur.x - startMid.x);
          roi.y = startRect.y + (cur.y - startMid.y);
          commit();
        }
        else if (fingers.size === 2) {
          const [a, b] = [...fingers.values()];
          const dist = Math.hypot(b.x - a.x, b.y - a.y);
          const scale = dist / startDist;
          roi.h = startRect.h / scale;
          roi.w = roi.h * ASPECT;
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          roi.x = mid.x - roi.w / 2;
          roi.y = mid.y - roi.h / 2;
          commit();
        }
      });

      function lift(e) {
        fingers.delete(e.pointerId);
        if (!fingers.size) commit();
      }
      frontOv.addEventListener('pointerup', lift);
      frontOv.addEventListener('pointercancel', lift);

      function zoomFromWheel(deltaY) {
        return Math.exp(deltaY * 0.001);
      }

      frontOv.addEventListener('wheel', e => {
        if (!Controller.isPreview()) return;
        e.preventDefault();
        const scale = zoomFromWheel(e.deltaY);
        const prevW = roi.w, prevH = roi.h;
        const newW = prevW * scale, newH = newW / ASPECT;

        roi.x -= (newW - prevW) / 2;
        roi.y -= (newH - prevH) / 2;
        roi.w = newW;
        roi.h = newH;
        commit();
      }, { passive: false });

      ['gesturestart', 'gesturechange', 'gestureend'].forEach(t =>
        frontOv.addEventListener(t, e => e.preventDefault())
      );

      frontOv.style.touchAction = 'none';
      const topHInp = $('#topHInp');
      const frontHInp = $('#frontHInp');
      const topMinInp = $('#topMinInp');
      const frontMinInp = $('#frontMinInp');
      topHInp.value = cfg.topH;
      frontHInp.value = cfg.frontH;
      topMinInp.value = cfg.TOP_MIN_AREA;
      frontMinInp.value = cfg.FRONT_MIN_AREA;

      topHInp.addEventListener('input', e => {
        cfg.topH = Math.max(10, Math.min(cfg.TOP_H, +e.target.value));
        Config.save('topH', cfg.topH);
        topROI.h = cfg.topH;
        commitTop();
      });
      frontHInp.addEventListener('input', e => {
        cfg.frontH = Math.max(10, Math.min(cfg.FRONT_H, +e.target.value));
        Config.save('frontH', cfg.frontH);
        roi.h = cfg.frontH;
        roi.w = roi.h * ASPECT;
        commit();
      });
      topMinInp.onchange = e => {
        cfg.TOP_MIN_AREA = Math.max(0, +e.target.value);
        Config.save('TOP_MIN_AREA', cfg.TOP_MIN_AREA);
      };
      frontMinInp.onchange = e => {
        cfg.FRONT_MIN_AREA = Math.max(0, +e.target.value);
        Config.save('FRONT_MIN_AREA', cfg.FRONT_MIN_AREA);
      };

      commit();
    })();

      urlI.value = cfg.url;
      selA.value = cfg.teamA;
      selB.value = cfg.teamB;
      updateThreshInputs();

    urlI.onblur = () => {
      cfg.url = urlI.value;
      Config.save('url', cfg.url);
      if (urlWarn) urlWarn.textContent = '';
    };
    
      selA.onchange = e => {
        cfg.teamA = e.target.value;
        Config.save('teamA', cfg.teamA);
        Game.setTeams(cfg.teamA, cfg.teamB);
        cfg.f16Ranges[cfg.teamA] = hsvRangeF16(cfg.teamA);
        updateThreshInputs();
      };
    selB.onchange = e => {
      cfg.teamB = e.target.value;
      Config.save('teamB', cfg.teamB);
      Game.setTeams(cfg.teamA, cfg.teamB);
    };
  }

  return { bind };
})();

const Feeds = (() => {
  const cfg = Config.get();
  let videoTop, videoFront, track, dc;

  async function initRTC() {
    const stateEl = $('#state');
    const log = msg => { if (stateEl) stateEl.textContent = msg; };
    log('Connecting…');

    let ctrl;
    try {
      ctrl = await StartB({ log });
    } catch (err) {
      log('ERR: ' + (err && (err.stack || err)));
      return false;
    }

    const pc = ctrl && ctrl.pc;
    if (!pc) { log('no offer found — open A first'); return false; }

    pc.ondatachannel = e => {
      dc = e.channel;
      log('connected');
      dc.onmessage = ev => {
        const bit = parseInt(ev.data, 10);
        if (!isNaN(bit)) Controller.handleBit(bit);
      };
    };

    window.sendBit = bit => { if (dc && dc.readyState === 'open') dc.send(bit); };
    return true;
  }

  async function init() {
    videoFront = $('#vid');

    if (cfg.topMode === TOP_MODE_MJPEG) {
      const urlWarnEl = $('#urlWarn');
      videoTop = new Image();
      videoTop.crossOrigin = 'anonymous';
      videoTop.src = cfg.url;
      try {
        await videoTop.decode();
      } catch (err) {
        if (urlWarnEl) urlWarnEl.textContent = '⚠️';
        console.log('Failed to load top camera feed', err);
        return false;
      }
    } else if (cfg.topMode === TOP_MODE_WEBRTC) {
      if (!await initRTC()) return false;
    } else {
      console.log('Unknown topMode', cfg.topMode);
      return false;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      console.log('getUserMedia not supported');
      return false;
    }
    let frontStream;
    try {
      frontStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { exact: cfg.FRONT_W },
          height: { exact: cfg.FRONT_H },
          facingMode: 'environment',
          frameRate: { ideal: 60, max: 120 }
        }
      });
    } catch (err) {
      console.log('Front camera init failed', err);
      return false;
    }

    videoFront.srcObject = frontStream;
    track = frontStream.getVideoTracks()[0];

    const cap = track.getCapabilities();
    const advConstraints = [];

    if (cap.powerEfficient) advConstraints.push({ powerEfficient: false });

    if (cap.zoom) {
      const zoomInput = $('#frontZoom');
      const { min, max, step } = cap.zoom;
      zoomInput.min = min;
      zoomInput.max = Math.min(2, max);
      zoomInput.step = step || 0.1;
      const storedZoom = localStorage.getItem('zoom');
      if (storedZoom !== null) cfg.zoom = JSON.parse(storedZoom);
      zoomInput.value = cfg.zoom;
      advConstraints.push({ zoom: cfg.zoom });
      zoomInput.addEventListener('input', async () => {
        const z = parseFloat(zoomInput.value);
        cfg.zoom = z;
        Config.save('zoom', cfg.zoom);
        try {
          await track.applyConstraints({ advanced: [{ zoom: z }] });
        } catch (err) {
          console.log('Zoom apply failed:', err);
        }
      });
    }

    try {
      await videoFront.play();
    } catch (err) {
      console.log('Front video play failed', err);
      return false;
    }
    if (
      cap.exposureMode &&
      cap.exposureMode.includes('manual') &&
      cap.exposureTime &&
      cap.iso
    ) {
      advConstraints.push({
        exposureMode: 'manual',
        exposureTime: 1 / 500,
        iso: 400,
      });
    }
    if (
      cap.focusMode &&
      cap.focusMode.includes('manual') &&
      cap.focusDistance
    ) {
      advConstraints.push({ focusMode: 'manual', focusDistance: 3.0 });
    }
    if (
      cap.whiteBalanceMode &&
      cap.whiteBalanceMode.includes('manual') &&
      cap.colorTemperature
    ) {
      advConstraints.push({
        whiteBalanceMode: 'manual',
        colorTemperature: 5600,
      });
    }
    if (advConstraints.length) {
      try {
        await new Promise((r) => setTimeout(r, 1500));
        await track.applyConstraints({ advanced: advConstraints });
      } catch (err) {
        console.log('Advanced constraints apply failed:', err);
      }
    }
    return true;
  }

  return {
    init,
    top: () => videoTop,
    front: () => videoFront
  };
})();

const Detect = (() => {
  const cfg = Config.get();
  let device, pipelines, pack, sampler, feedTop, feedFront;

  function rectTop() {
    const ys = cfg.polyT.map(p => p[1]);
    return { min: [0, Math.min(...ys)], max: [cfg.TOP_W, Math.max(...ys)] };
  }
  function rectFront() {
    const xs = cfg.polyF.map(p => p[0]), ys = cfg.polyF.map(p => p[1]);
    return {
      min: [Math.min(...xs), Math.min(...ys)],
      max: [Math.max(...xs), Math.max(...ys)]
    };
  }

  async function init() {
    if (!('gpu' in navigator)) {
      console.log('WebGPU not supported');
      return false;
    }
    let adapter;
    try {
      adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    } catch (err) {
      console.log('Adapter request failed', err);
      return false;
    }
    if (!adapter) {
      console.log('No WebGPU adapter');
      return false;
    }
    let hasF16 = false;
    try {
      hasF16 = adapter.features?.has && adapter.features.has("shader-f16");
    } catch (err) {
      console.log('f16 check failed', err);
    }
    try {
      device = await adapter.requestDevice({ requiredFeatures: hasF16 ? ["shader-f16"] : [] });
    } catch (err) {
      console.log('Device request failed', err);
      return false;
    }
    console.log("shader-f16:", hasF16);

    pipelines = await GPUShared.createPipelines(device, {});
    sampler = device.createSampler();
    pack = GPUShared.createUniformPack(device);
    feedTop = GPUShared.createFeed(device, pipelines, sampler, cfg.TOP_W, cfg.TOP_H);
    feedFront = GPUShared.createFeed(device, pipelines, sampler, cfg.FRONT_W, cfg.FRONT_H);
    return true;
  }

  async function detectPass(source, feed, rect, flags, preview, which, origin = { x: 0, y: 0 }, flipY = true) {
    pack.resetStats(device.queue);
    GPUShared.copyFrame(device.queue, source, feed, origin, flipY);
    const enc = device.createCommandEncoder();
    GPUShared.clearMask(enc, feed);
    pack.writeUniform(device.queue, cfg.f16Ranges[cfg.teamA], cfg.f16Ranges[cfg.teamB], rect, flags);
    GPUShared.encodeCompute(enc, pipelines, feed, pack);
    if (preview) {
      PreviewGfx.drawMask(enc, pipelines, feed, device, which);
    }
    device.queue.submit([enc.finish()]);
    return pack.readStats();
  }

  async function runTopDetection(preview) {
    const src = Feeds.top();
    const srcY = Math.floor((src.naturalHeight - cfg.TOP_H) / 2);
    const flagsTop = (preview ? FLAG_PREVIEW : 0) | FLAG_TEAM_A_ACTIVE | FLAG_TEAM_B_ACTIVE;
    const { a, b } = await detectPass(src, feedTop, rectTop(), flagsTop, preview, 'top', { x: 0, y: srcY }, true);
    const cntA = a[0], cntB = b[0];
    const topDetected = cntA > cfg.TOP_MIN_AREA || cntB > cfg.TOP_MIN_AREA;
    return { detected: topDetected, cntA, cntB };
  }

  let lastCaptureTime = 0;
  async function runFrontDetection(flags, preview) {
    const meta = await new Promise(res => Feeds.front().requestVideoFrameCallback((_n, m) => res(m)));
    if (meta.captureTime === lastCaptureTime) return { detected: false, hits: [] };
    lastCaptureTime = meta.captureTime;
    const { a, b } = await detectPass(Feeds.front(), feedFront, rectFront(), flags, preview, 'front');
    const [cntA, sumXA, sumYA] = a;
    const [cntB, sumXB, sumYB] = b;
    const hits = [];
    if (cntA > cfg.FRONT_MIN_AREA) {
      const cx = sumXA / cntA, cy = sumYA / cntA;
      hits.push({ team: cfg.teamA, x: cx / cfg.FRONT_W, y: cy / cfg.FRONT_H });
    }
    if (cntB > cfg.FRONT_MIN_AREA) {
      const cx = sumXB / cntB, cy = sumYB / cntB;
      hits.push({ team: cfg.teamB, x: cx / cfg.FRONT_W, y: cy / cfg.FRONT_H });
    }
    if (preview && hits.length) {
      for (const h of hits) PreviewGfx.drawHit(h);
    }
    return { detected: hits.length > 0, hits };
  }

  return { init, runTopDetection, runFrontDetection };
})();

const Controller = (() => {
  const cfg = Config.get();
  const TOP_FPS = 30;               // throttle only the MJPEG-top feed
  const TOP_INTERVAL = 1000 / TOP_FPS;
  let lastTop = 0;
  let preview = false;

  async function topLoop(ts) {
    if (ts - lastTop < TOP_INTERVAL) {
      requestAnimationFrame(topLoop);
      return;
    }
    lastTop = ts;

    const { detected: topDetected, cntA, cntB } = await Detect.runTopDetection(preview);

    if (topDetected) {
      let flags = preview ? FLAG_PREVIEW : 0;
      if (cntA > cfg.TOP_MIN_AREA) flags |= FLAG_TEAM_A_ACTIVE;
      if (cntB > cfg.TOP_MIN_AREA) flags |= FLAG_TEAM_B_ACTIVE;

      const { detected: frontDetected, hits } = await Detect.runFrontDetection(flags, preview);

      if (frontDetected) {
        for (const h of hits) {
          Game.routeHit(
            h.x * window.innerWidth,
            h.y * window.innerHeight,
            h.team
          );
          console.log('Queued hit:', h);
        }
      }
    }
    requestAnimationFrame(topLoop);
  }

  async function handleBit(bit) {
    let flags = preview ? FLAG_PREVIEW : 0;
    if (bit === 0 || bit === 2) flags |= FLAG_TEAM_A_ACTIVE;
    if (bit === 1 || bit === 2) flags |= FLAG_TEAM_B_ACTIVE;
    if (!(flags & (FLAG_TEAM_A_ACTIVE | FLAG_TEAM_B_ACTIVE))) return;
    const { detected: frontDetected, hits } = await Detect.runFrontDetection(flags, preview);
    if (frontDetected) {
      for (const h of hits) {
        Game.routeHit(
          h.x * window.innerWidth,
          h.y * window.innerHeight,
          h.team
        );
        console.log('Queued hit:', h);
      }
    }
  }

  async function start() {
    Setup.bind();
    if (!await Feeds.init()) return;
    if (!await Detect.init()) return;
    lastTop = 0;
    if (cfg.topMode === TOP_MODE_MJPEG) {
      requestAnimationFrame(topLoop);
    }
  }

  function setPreview(on) { preview = on; }
  function isPreview() { return preview; }

  return { start, setPreview, isPreview, handleBit };
})();
window.App = { Config, PreviewGfx, Setup, Feeds, Detect, Controller };
Controller.start();
})();
