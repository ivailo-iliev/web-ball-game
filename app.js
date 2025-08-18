// app.js – dual-camera WebGPU detection with throttled setup and one-shot front processing
// ------------------------------------------------------------------------------
// * Continuous WebGPU detection on MJPEG "top" feed
// * One-shot WebGPU detection on device-camera "front" feed upon impact
// * Identical pipeline in setup (throttled) and live (triggered)

(function () {
  'use strict';

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
const hsvRangeF16 = t => GPUShared.hsvRangeF16(TEAM_INDICES, COLOR_TABLE, t);

const DEFAULTS = {
  topResW: 640,
  topResH: 480,
  frontResW: 1280,
  frontResH: 590,
  topMinArea: 400,
  frontMinArea: 8000,
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
          ctxTopGPU?.configure({ device, format: 'rgba8unorm', alphaMode: 'opaque' });
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
          ctxFrontGPU?.configure({ device, format: 'rgba8unorm', alphaMode: 'opaque' });
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
    const px = hit.x * cfg.frontResW, py = hit.y * cfg.frontResH;
    ctxFront2d.beginPath();
    ctxFront2d.arc(px, py, 8, 0, Math.PI * 2);
    ctxFront2d.fill();
  }

  function view(device, which) {
    ensureGPU(device);
    const ctx = which === 'front' ? ctxFrontGPU : ctxTopGPU;
    return ctx ? ctx.getCurrentTexture().createView() : null;
  }

  return { view, drawROI, drawHit, clear };
})();


const Setup = (() => {
  const cfg = Config.get();
  const detectionUI = `
  <div class=cam id=topCam>
    <canvas id=topTex width=${cfg.topResW} height=${cfg.topResH}></canvas>
    <canvas id=topOv class=overlay width=${cfg.topResW} height=${cfg.topResH}></canvas>
  </div>
  <div class=cam id=frontCam>
   <video id=vid autoplay playsinline style="display: none;"></video>
   <canvas id="frontTex" width=${cfg.frontResW} height=${cfg.frontResH}></canvas>
   <canvas id=frontOv  class=overlay width=${cfg.frontResW} height=${cfg.frontResH}></canvas>
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
    <label for=topHInp>↕️ <input id=topHInp   type=number min=10 max=${cfg.topResH} step=1></label>
    <label for=frontMinInp>⚫ <input id=frontMinInp type=number min=0 step=100  style="width:6ch"></label>
    <label for=frontHInp>↕️ <input id=frontHInp type=number min=10 max=${cfg.frontResH} step=1></label>
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
    topROI.y = Math.min(Math.max(0, topROI.y), cfg.topResH - topROI.h);
    const { y, h } = topROI;
    cfg.polyT = [[0, y], [cfg.topResW, y], [cfg.topResW, y + h], [0, y + h]];
    Config.save('polyT', cfg.polyT);
    drawPolyTop();
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
      dragY = (e.clientY - r.top) * cfg.topResH / r.height;
      topOv.setPointerCapture(e.pointerId);
    });
    topOv.addEventListener('pointermove', e => {
      if (dragY == null || !Controller.isPreview()) return;
      const r = topOv.getBoundingClientRect();
      const curY = (e.clientY - r.top) * cfg.topResH / r.height;
      topROI.y += curY - dragY;
      dragY = curY;
      commitTop();
    });
    topOv.addEventListener('pointerup', () => dragY = null);
    topOv.addEventListener('pointercancel', () => dragY = null);

    commitTop();

    (function () {
      // Front ROI: fixed aspect, height-driven; gesture = drag only
      const ASPECT = cfg.frontResW / cfg.frontResH;
      let roi = { x: 0, y: 0, w: cfg.frontH * ASPECT, h: cfg.frontH };
      if (cfg.polyF?.length === 4) {
        const xs = cfg.polyF.map(p => p[0]), ys = cfg.polyF.map(p => p[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs);
        const y0 = Math.min(...ys), y1 = Math.max(...ys);
        roi = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        // re-lock width to height*aspect in case stored poly drifted
        roi.h = Math.max(10, Math.min(cfg.frontResH, roi.h));
        roi.w = roi.h * ASPECT;
      }

      function commit() {
        // lock width to height * aspect and clamp inside framebuffer
        roi.h = Math.max(10, Math.min(cfg.frontResH, roi.h));
        roi.w = roi.h * ASPECT;
        roi.x = Math.min(Math.max(0, roi.x), cfg.frontResW - roi.w);
        roi.y = Math.min(Math.max(0, roi.y), cfg.frontResH - roi.h);
        // write polygon in TL,TR,BR,BL order for downstream code
        const x0 = Math.round(roi.x), y0 = Math.round(roi.y);
        const x1 = Math.round(roi.x + roi.w), y1 = Math.round(roi.y + roi.h);
        cfg.polyF = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        Config.save('polyF', cfg.polyF);
        drawPolyFront();
      }

      function toCanvas(e) {
        const r = frontOv.getBoundingClientRect();
        return {
          x: (e.clientX - r.left) * cfg.frontResW / r.width,
          y: (e.clientY - r.top) * cfg.frontResH / r.height
        };
      }

      // Drag-only gesture
      let dragStart, roiStart;
      frontOv.addEventListener('pointerdown', e => {
        if (!Controller.isPreview()) return;
        frontOv.setPointerCapture(e.pointerId);
        dragStart = toCanvas(e);
        roiStart = { x: roi.x, y: roi.y, w: roi.w, h: roi.h };
      });
      frontOv.addEventListener('pointermove', e => {
        if (!dragStart || !Controller.isPreview()) return;
        const cur = toCanvas(e);
        roi.x = roiStart.x + (cur.x - dragStart.x);
        roi.y = roiStart.y + (cur.y - dragStart.y);
        commit();
      });
      function lift() { dragStart = null; roiStart = null; }
      frontOv.addEventListener('pointerup', lift);
      frontOv.addEventListener('pointercancel', lift);

      frontOv.style.touchAction = 'none';
      const topHInp = $('#topHInp');
      const frontHInp = $('#frontHInp');
      const topMinInp = $('#topMinInp');
      const frontMinInp = $('#frontMinInp');
      topHInp.value = cfg.topH;
      frontHInp.value = cfg.frontH;
      topMinInp.value = cfg.topMinArea;
      frontMinInp.value = cfg.frontMinArea;

      topHInp.addEventListener('input', e => {
        cfg.topH = Math.max(10, Math.min(cfg.topResH, +e.target.value));
        Config.save('topH', cfg.topH);
        topROI.h = cfg.topH;
        commitTop();
      });
      frontHInp.addEventListener('input', e => {
        cfg.frontH = Math.max(10, Math.min(cfg.frontResH, +e.target.value));
        Config.save('frontH', cfg.frontH);
        roi.h = cfg.frontH;               // width is recomputed in commit()
        commit();
      });
      topMinInp.onchange = e => {
        cfg.topMinArea = Math.max(0, +e.target.value);
        Config.save('topMinArea', cfg.topMinArea);
      };
      frontMinInp.onchange = e => {
        cfg.frontMinArea = Math.max(0, +e.target.value);
        Config.save('frontMinArea', cfg.frontMinArea);
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
          width: { exact: cfg.frontResW },
          height: { exact: cfg.frontResH },
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

  function rectTop() {
    const ys = cfg.polyT.map(p => p[1]);
    return { min: [0, Math.min(...ys)], max: [cfg.topResW, Math.max(...ys)] };
  }
  function rectFront() {
    const xs = cfg.polyF.map(p => p[0]), ys = cfg.polyF.map(p => p[1]);
    return {
      min: [Math.min(...xs), Math.min(...ys)],
      max: [Math.max(...xs), Math.max(...ys)]
    };
  }

  async function init() {
    // all GPU checks/device creation removed
    // rely on GPUShared.detect to throw if unsupported
    return true;
  }
  async function runTopDetection(preview) {
    const { a, b } = await GPUShared.detect({
      key: 'top',
      source: Feeds.top(),
      hsvA6: cfg.f16Ranges[cfg.teamA],  // still floats; GPUShared converts to f16
      hsvB6: cfg.f16Ranges[cfg.teamB],
      rect: rectTop(),
      previewCanvas: preview ? document.getElementById('topTex') : null,
      preview,
      activeA: true,
      activeB: true,
      flipY: true
    });
    const cntA = a[0], cntB = b[0];
    const topDetected = cntA > cfg.topMinArea || cntB > cfg.topMinArea;
    return { detected: topDetected, cntA, cntB };
  }

  let lastCaptureTime = 0;
  async function runFrontDetection(aActive, bActive, preview) {
    const meta = await new Promise(res => Feeds.front().requestVideoFrameCallback((_n, m) => res(m)));
    if (meta.captureTime === lastCaptureTime) return { detected: false, hits: [] };
    lastCaptureTime = meta.captureTime;
    const { a, b } = await GPUShared.detect({
      key: 'front',
      source: Feeds.front(),
      hsvA6: cfg.f16Ranges[cfg.teamA],
      hsvB6: cfg.f16Ranges[cfg.teamB],
      rect: rectFront(),
      previewCanvas: preview ? document.getElementById('frontTex') : null,
      preview,
      activeA: aActive,
      activeB: bActive,
      flipY: true
    });
    const [cntA, sumXA, sumYA] = a;
    const [cntB, sumXB, sumYB] = b;
    const hits = [];
    if (cntA > cfg.frontMinArea) {
      const cx = sumXA / cntA, cy = sumYA / cntA;
      hits.push({ team: cfg.teamA, x: cx / cfg.frontResW, y: cy / cfg.frontResH });
    }
    if (cntB > cfg.frontMinArea) {
      const cx = sumXB / cntB, cy = sumYB / cntB;
      hits.push({ team: cfg.teamB, x: cx / cfg.frontResW, y: cy / cfg.frontResH });
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
      const aActive = cntA > cfg.topMinArea;
      const bActive = cntB > cfg.topMinArea;
      const { detected: frontDetected, hits } = await Detect.runFrontDetection(aActive, bActive, preview);

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
    const aActive = (bit === 0 || bit === 2);
    const bActive = (bit === 1 || bit === 2);
    if (!aActive && !bActive) return;
    const { detected: frontDetected, hits } = await Detect.runFrontDetection(aActive, bActive, preview);
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
