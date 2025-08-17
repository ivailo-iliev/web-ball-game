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
const { PREVIEW: FLAG_PREVIEW, TEAM_A: FLAG_TEAM_A_ACTIVE, TEAM_B: FLAG_TEAM_B_ACTIVE } =
  GPUShared.FLAGS;

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
  const el = {};
  let thInputs = [];

  function updateThreshInputs(cfg, inputs) {
    const base = TEAM_INDICES[cfg.teamA] * 6;
    for (let i = 0; i < 6; i++) inputs[i].value = (+COLOR_TABLE[base + i].toFixed(2));
  }

  function createThreshInputs(container, handler) {
    const inputs = [];
    for (let i = 0; i < 6; i++) {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = '0';
      inp.max = '1';
      inp.step = '0.05';
      inp.style.width = '4ch';
      inp.dataset.idx = String(i);
      container.appendChild(inp);
      inp.addEventListener('input', handler);
      inputs.push(inp);
    }
    return inputs;
  }

  function initNumberSpinners() {
    document.querySelectorAll('input[type=number]:not([data-spinner])').forEach(input => {
      input.setAttribute('data-spinner', '');

      const wrap = document.createElement('span');
      wrap.className = 'num-spinner';
      input.before(wrap);

      const btnDown = Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'down',
        textContent: '−',
        onclick() {
          input.stepDown();
          input.dispatchEvent(new Event('input', { bubbles: true }));
          update();
        }
      });
      const btnUp = Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'up',
        textContent: '+',
        onclick() {
          input.stepUp();
          input.dispatchEvent(new Event('input', { bubbles: true }));
          update();
        }
      });

      wrap.append(input, btnDown, btnUp);

      const min = parseFloat(input.min);
      const max = parseFloat(input.max);

      const update = () => {
        const val = parseFloat(input.value);
        btnDown.disabled = !isNaN(min) && val <= min;
        btnUp.disabled = !isNaN(max) && val >= max;
      };
      input.addEventListener('input', update);
      update();
    });
  }

  function ROI(opts) {
    const roi = {
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      which: opts.which,
      color: opts.color,
      allowX: opts.allowX,
      maintainAspect: opts.maintainAspect,
      keys: opts.keys
    };

    function setHeight(h) {
      const resH = cfg[roi.keys.resH];
      roi.h = Math.round(u.clamp(Number(h), 10, resH));
      if (roi.maintainAspect) {
        const resW = cfg[roi.keys.resW];
        roi.w = roi.h * (resW / resH);
      } else {
        roi.w = cfg[roi.keys.resW];
        roi.x = 0;
      }
      cfg[roi.keys.height] = roi.h;
      Config.save(roi.keys.height, roi.h);
      commit();
    }

    function commit() {
      const resW = cfg[roi.keys.resW];
      const resH = cfg[roi.keys.resH];
      if (!roi.allowX) {
        roi.x = 0;
        roi.w = resW;
      } else if (roi.maintainAspect) {
        roi.w = roi.h * (resW / resH);
      }
      roi.x = u.clamp(roi.x, 0, resW - roi.w);
      roi.y = u.clamp(roi.y, 0, resH - roi.h);
      const x0 = Math.round(roi.x), y0 = Math.round(roi.y);
      const x1 = Math.round(roi.x + roi.w), y1 = Math.round(roi.y + roi.h);
      cfg[roi.keys.poly] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      Config.save(roi.keys.poly, cfg[roi.keys.poly]);
      PreviewGfx.drawROI(cfg[roi.keys.poly], roi.color, roi.which);
    }

    function attach(canvas) {
      canvas.style.touchAction = 'none';

      if (!roi.allowX) {
        let dragY = null;
        canvas.addEventListener('pointerdown', function (e) {
          if (!Controller.isPreview()) return;
          const r = canvas.getBoundingClientRect();
          dragY = (e.clientY - r.top) * cfg[roi.keys.resH] / r.height;
          canvas.setPointerCapture(e.pointerId);
        });
        canvas.addEventListener('pointermove', function (e) {
          if (dragY == null || !Controller.isPreview()) return;
          const r = canvas.getBoundingClientRect();
          const curY = (e.clientY - r.top) * cfg[roi.keys.resH] / r.height;
          roi.y += curY - dragY;
          dragY = curY;
          commit();
        });
        function lift() { dragY = null; }
        canvas.addEventListener('pointerup', lift);
        canvas.addEventListener('pointercancel', lift);
      } else {
        let dragStart = null, roiStart = null;
        function toCanvas(e) {
          const r = canvas.getBoundingClientRect();
          return {
            x: (e.clientX - r.left) * cfg[roi.keys.resW] / r.width,
            y: (e.clientY - r.top) * cfg[roi.keys.resH] / r.height
          };
        }
        canvas.addEventListener('pointerdown', function (e) {
          if (!Controller.isPreview()) return;
          canvas.setPointerCapture(e.pointerId);
          dragStart = toCanvas(e);
          roiStart = { x: roi.x, y: roi.y };
        });
        canvas.addEventListener('pointermove', function (e) {
          if (!dragStart || !Controller.isPreview()) return;
          const cur = toCanvas(e);
          roi.x = roiStart.x + (cur.x - dragStart.x);
          roi.y = roiStart.y + (cur.y - dragStart.y);
          commit();
        });
        function lift() { dragStart = null; roiStart = null; }
        canvas.addEventListener('pointerup', lift);
        canvas.addEventListener('pointercancel', lift);
      }
      commit();
    }

    return Object.assign(roi, { setHeight, commit, attach });
  }

  const TopROI = ROI({
    which: 'top',
    color: 'lime',
    allowX: false,
    maintainAspect: false,
    keys: { resW: 'topResW', resH: 'topResH', poly: 'polyT', height: 'topH' }
  });

  const FrontROI = ROI({
    which: 'front',
    color: 'aqua',
    allowX: true,
    maintainAspect: true,
    keys: { resW: 'frontResW', resH: 'frontResH', poly: 'polyF', height: 'frontH' }
  });

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
    <label for=teamA>🅰️ <select id=teamA></select></label>
    <label for=teamB>🅱️ <select id=teamB></select></label>
    <label>HSV <span id=teamAThresh></span></label>
  </div>`;

  function renderUI() {
    $('#configScreen').insertAdjacentHTML('beforeend', detectionUI);
  }

  function cacheElements() {
    el.topOv = $('#topOv');
    el.frontOv = $('#frontOv');
    el.topMode = $('#topMode');
    el.topUrl = $('#topUrl');
    el.urlWarn = $('#urlWarn');
    el.teamA = $('#teamA');
    el.teamB = $('#teamB');
    el.teamAThresh = $('#teamAThresh');
    el.topH = $('#topHInp');
    el.frontH = $('#frontHInp');
    el.topMin = $('#topMinInp');
    el.frontMin = $('#frontMinInp');
    el.btnStart = $('#btnStart');
  }

  function onInputThresh(e) {
    const idx = +e.target.dataset.idx;
    const base = TEAM_INDICES[cfg.teamA] * 6 + idx;
    COLOR_TABLE[base] = parseFloat(e.target.value);
    localStorage.setItem('COLOR_TABLE', JSON.stringify(Array.from(COLOR_TABLE)));
    cfg.f16Ranges[cfg.teamA] = hsvRangeF16(cfg.teamA);
  }

  function initInputs() {
    populateTeamSelects(el.teamA, el.teamB, COLOR_EMOJI);
    thInputs = createThreshInputs(el.teamAThresh, onInputThresh);
    el.topMode.value = cfg.topMode;
    el.topUrl.value = cfg.url;
    el.teamA.value = cfg.teamA;
    el.teamB.value = cfg.teamB;
    el.topH.value = cfg.topH;
    el.frontH.value = cfg.frontH;
    el.topMin.value = cfg.topMinArea;
    el.frontMin.value = cfg.frontMinArea;
    if (cfg.polyT.length === 4) {
      const ys = cfg.polyT.map(p => p[1]);
      TopROI.y = Math.min(...ys);
      TopROI.h = Math.max(...ys) - TopROI.y;
    }
    if (cfg.polyF.length === 4) {
      const xs = cfg.polyF.map(p => p[0]), ys = cfg.polyF.map(p => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const y0 = Math.min(...ys), y1 = Math.max(...ys);
      FrontROI.x = x0; FrontROI.y = y0; FrontROI.w = x1 - x0; FrontROI.h = y1 - y0;
    }
    TopROI.setHeight(cfg.topH);
    FrontROI.setHeight(cfg.frontH);
    Game.setTeams(cfg.teamA, cfg.teamB);
    updateThreshInputs(cfg, thInputs);
    initNumberSpinners();
  }

  function attachEvents() {
    el.topMode.addEventListener('change', onChangeTopMode);
    el.topUrl.addEventListener('blur', onBlurTopUrl);
    el.teamA.addEventListener('change', onChangeTeamA);
    el.teamB.addEventListener('change', onChangeTeamB);
    el.topH.addEventListener('input', onChangeTopH);
    el.frontH.addEventListener('input', onChangeFrontH);
    el.topMin.addEventListener('input', onInputTopMin);
    el.frontMin.addEventListener('input', onInputFrontMin);
    el.btnStart.addEventListener('click', onClickStart);
    TopROI.attach(el.topOv);
    FrontROI.attach(el.frontOv);
  }

  function onChangeTopMode(e) {
    cfg.topMode = e.target.value;
    Config.save('topMode', cfg.topMode);
  }

  function onBlurTopUrl() {
    cfg.url = el.topUrl.value;
    Config.save('url', cfg.url);
    if (el.urlWarn) el.urlWarn.textContent = '';
  }

  function onChangeTeamA(e) {
    cfg.teamA = e.target.value;
    Config.save('teamA', cfg.teamA);
    Game.setTeams(cfg.teamA, cfg.teamB);
    cfg.f16Ranges[cfg.teamA] = hsvRangeF16(cfg.teamA);
    updateThreshInputs(cfg, thInputs);
  }

  function onChangeTeamB(e) {
    cfg.teamB = e.target.value;
    Config.save('teamB', cfg.teamB);
    Game.setTeams(cfg.teamA, cfg.teamB);
  }

    function onChangeTopH(e) {
      const h = Math.round(u.clamp(Number(e.target.value), 10, cfg.topResH));
      e.target.value = h;
      TopROI.setHeight(h);
    }

    function onChangeFrontH(e) {
      const h = Math.round(u.clamp(Number(e.target.value), 10, cfg.frontResH));
      e.target.value = h;
      FrontROI.setHeight(h);
    }

    function onInputTopMin(e) {
      cfg.topMinArea = Math.round(u.clamp(Number(e.target.value), 0, Number.MAX_SAFE_INTEGER));
      Config.save('topMinArea', cfg.topMinArea);
    }

    function onInputFrontMin(e) {
      cfg.frontMinArea = Math.round(u.clamp(Number(e.target.value), 0, Number.MAX_SAFE_INTEGER));
      Config.save('frontMinArea', cfg.frontMinArea);
    }

  function onClickStart() {
    Controller.start();
  }

  return {
    bind() {
      renderUI();
      cacheElements();
      initInputs();
      attachEvents();
    }
  };
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
  async function runFrontDetection(flags, preview) {
    const meta = await new Promise(res => Feeds.front().requestVideoFrameCallback((_n, m) => res(m)));
    if (meta.captureTime === lastCaptureTime) return { detected: false, hits: [] };
    lastCaptureTime = meta.captureTime;
    const aActive = !!(flags & 2), bActive = !!(flags & 4); // using your semantics
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
      let flags = preview ? FLAG_PREVIEW : 0;
      if (cntA > cfg.topMinArea) flags |= FLAG_TEAM_A_ACTIVE;
      if (cntB > cfg.topMinArea) flags |= FLAG_TEAM_B_ACTIVE;

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
