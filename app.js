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

const TEAM_INDICES = { red: 0, green: 1, blue: 2, yellow: 3 };
const COLOR_EMOJI = {
  red: '🔴',
  green: '🟢',
  blue: '🔵',
  yellow: '🟡'
};

const DOM_THR_DEFAULT = 0.10;
const SATMIN_DEFAULT  = 0.12;
const YMIN_DEFAULT    = 0.00;
const YMAX_DEFAULT    = 0.70;
const RADIUS_DEFAULT  = 18;

const DEFAULTS = {
  topResW: 640,
  topResH: 480,
  frontResW: 1280,
  frontResH: 590,
  topMinArea: 400,
  frontMinArea: 8000,
  radiusPx: RADIUS_DEFAULT,
  domThr: [DOM_THR_DEFAULT, DOM_THR_DEFAULT, DOM_THR_DEFAULT, DOM_THR_DEFAULT],
  satMin: [SATMIN_DEFAULT, SATMIN_DEFAULT, SATMIN_DEFAULT, SATMIN_DEFAULT],
  yMin:   [YMIN_DEFAULT,   YMIN_DEFAULT,   YMIN_DEFAULT,   YMIN_DEFAULT],
  yMax:   [YMAX_DEFAULT,   YMAX_DEFAULT,   YMAX_DEFAULT,   YMAX_DEFAULT],
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
Config.load();

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
    <label for=domA>domA <input id=domA type=number step=0.01 style="width:5ch"></label>
    <label for=satMinA>satA <input id=satMinA type=number step=0.01 style="width:5ch"></label>
    <label for=yMinA>yMinA <input id=yMinA type=number step=0.01 style="width:5ch"></label>
    <label for=yMaxA>yMaxA <input id=yMaxA type=number step=0.01 style="width:5ch"></label>
    <label for=teamB>🅱️ <select id=teamB>${Object.entries(COLOR_EMOJI).map(([c, e]) => `<option value="${c}">${e}</option>`).join('')}</select></label>
    <label for=domB>domB <input id=domB type=number step=0.01 style="width:5ch"></label>
    <label for=satMinB>satB <input id=satMinB type=number step=0.01 style="width:5ch"></label>
    <label for=yMinB>yMinB <input id=yMinB type=number step=0.01 style="width:5ch"></label>
    <label for=yMaxB>yMaxB <input id=yMaxB type=number step=0.01 style="width:5ch"></label>
    <label for=radiusPx>⌀ <input id=radiusPx type=number style="width:6ch"></label>
  </div>`;

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

  function bind() {
    $('#configScreen').insertAdjacentHTML('beforeend', detectionUI);
    const urlI = $('#topUrl');
    const urlWarn = $('#urlWarn');
    const selMode = $('#topMode');
      const selA = $('#teamA');
      const selB = $('#teamB');
      const domAInput = $('#domA');
      const domBInput = $('#domB');
      const satMinAInput = $('#satMinA');
      const satMinBInput = $('#satMinB');
      const yMinAInput = $('#yMinA');
      const yMinBInput = $('#yMinB');
      const yMaxAInput = $('#yMaxA');
      const yMaxBInput = $('#yMaxB');
      const radiusInput = $('#radiusPx');

      let teamA = cfg.teamA;
      let teamB = cfg.teamB;
      let domThrA = cfg.domThr[TEAM_INDICES[teamA]];
      let domThrB = cfg.domThr[TEAM_INDICES[teamB]];
      let satMinA = cfg.satMin[TEAM_INDICES[teamA]];
      let satMinB = cfg.satMin[TEAM_INDICES[teamB]];
      let yMinA = cfg.yMin[TEAM_INDICES[teamA]];
      let yMinB = cfg.yMin[TEAM_INDICES[teamB]];
      let yMaxA = cfg.yMax[TEAM_INDICES[teamA]];
      let yMaxB = cfg.yMax[TEAM_INDICES[teamB]];

      domAInput.value = domThrA;
      domBInput.value = domThrB;
      satMinAInput.value = satMinA;
      satMinBInput.value = satMinB;
      yMinAInput.value = yMinA;
      yMinBInput.value = yMinB;
      yMaxAInput.value = yMaxA;
      yMaxBInput.value = yMaxB;
      radiusInput.value = cfg.radiusPx;

      domAInput.addEventListener('input', e => {
        cfg.domThr[TEAM_INDICES[teamA]] = domThrA = +e.target.value;
        Config.save('domThr', Array.from(cfg.domThr));
      });
      domBInput.addEventListener('input', e => {
        cfg.domThr[TEAM_INDICES[teamB]] = domThrB = +e.target.value;
        Config.save('domThr', Array.from(cfg.domThr));
      });
      satMinAInput.addEventListener('input', e => {
        cfg.satMin[TEAM_INDICES[teamA]] = satMinA = +e.target.value;
        Config.save('satMin', Array.from(cfg.satMin));
      });
      satMinBInput.addEventListener('input', e => {
        cfg.satMin[TEAM_INDICES[teamB]] = satMinB = +e.target.value;
        Config.save('satMin', Array.from(cfg.satMin));
      });
      yMinAInput.addEventListener('input', e => {
        cfg.yMin[TEAM_INDICES[teamA]] = yMinA = +e.target.value;
        Config.save('yMin', Array.from(cfg.yMin));
      });
      yMinBInput.addEventListener('input', e => {
        cfg.yMin[TEAM_INDICES[teamB]] = yMinB = +e.target.value;
        Config.save('yMin', Array.from(cfg.yMin));
      });
      yMaxAInput.addEventListener('input', e => {
        cfg.yMax[TEAM_INDICES[teamA]] = yMaxA = +e.target.value;
        Config.save('yMax', Array.from(cfg.yMax));
      });
      yMaxBInput.addEventListener('input', e => {
        cfg.yMax[TEAM_INDICES[teamB]] = yMaxB = +e.target.value;
        Config.save('yMax', Array.from(cfg.yMax));
      });
      radiusInput.addEventListener('input', e => {
        cfg.radiusPx = Math.max(0, +e.target.value);
        Config.save('radiusPx', cfg.radiusPx);
      });

      selMode.value = cfg.topMode;
      selMode.onchange = e => {
        cfg.topMode = e.target.value;
        Config.save('topMode', cfg.topMode);
      };

      initNumberSpinners();
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
        selA.value = teamA;
        selB.value = teamB;

    urlI.onblur = () => {
      cfg.url = urlI.value;
      Config.save('url', cfg.url);
      if (urlWarn) urlWarn.textContent = '';
    };
    
      selA.addEventListener('change', e => {
        teamA = cfg.teamA = e.target.value;
        Config.save('teamA', teamA);
        Game.setTeams(cfg.teamA, cfg.teamB);
        domThrA = cfg.domThr[TEAM_INDICES[teamA]];
        satMinA = cfg.satMin[TEAM_INDICES[teamA]];
        yMinA = cfg.yMin[TEAM_INDICES[teamA]];
        yMaxA = cfg.yMax[TEAM_INDICES[teamA]];
        domAInput.value = domThrA;
        satMinAInput.value = satMinA;
        yMinAInput.value = yMinA;
        yMaxAInput.value = yMaxA;
      });
      selB.addEventListener('change', e => {
        teamB = cfg.teamB = e.target.value;
        Config.save('teamB', teamB);
        Game.setTeams(cfg.teamA, cfg.teamB);
        domThrB = cfg.domThr[TEAM_INDICES[teamB]];
        satMinB = cfg.satMin[TEAM_INDICES[teamB]];
        yMinB = cfg.yMin[TEAM_INDICES[teamB]];
        yMaxB = cfg.yMax[TEAM_INDICES[teamB]];
        domBInput.value = domThrB;
        satMinBInput.value = satMinB;
        yMinBInput.value = yMinB;
        yMaxBInput.value = yMaxB;
      });
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
    const colorA = TEAM_INDICES[cfg.teamA];
    const colorB = TEAM_INDICES[cfg.teamB];
    const { a, b } = await GPUShared.detect({
      key: 'top',
      source: Feeds.top(),
      colorA,
      colorB,
      domThrA: cfg.domThr[colorA],
      satMinA: cfg.satMin[colorA],
      yMinA: cfg.yMin[colorA],
      yMaxA: cfg.yMax[colorA],
      domThrB: cfg.domThr[colorB],
      satMinB: cfg.satMin[colorB],
      yMinB: cfg.yMin[colorB],
      yMaxB: cfg.yMax[colorB],
      radiusPx: cfg.radiusPx,
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
  let frontRunning = false;
  async function runFrontDetection(aActive, bActive, preview) {
    if (frontRunning) return { detected: false, hits: [] };
    frontRunning = true;
    try {
      const meta = await new Promise(res => Feeds.front().requestVideoFrameCallback((_n, m) => res(m)));
      if (meta.captureTime === lastCaptureTime) return { detected: false, hits: [] };
      lastCaptureTime = meta.captureTime;
      const colorA = TEAM_INDICES[cfg.teamA];
      const colorB = TEAM_INDICES[cfg.teamB];
      const { a, b } = await GPUShared.detect({
        key: 'front',
        source: Feeds.front(),
        colorA,
        colorB,
        domThrA: cfg.domThr[colorA],
        satMinA: cfg.satMin[colorA],
        yMinA: cfg.yMin[colorA],
        yMaxA: cfg.yMax[colorA],
        domThrB: cfg.domThr[colorB],
        satMinB: cfg.satMin[colorB],
        yMinB: cfg.yMin[colorB],
        yMaxB: cfg.yMax[colorB],
        radiusPx: cfg.radiusPx,
        rect: rectFront(),
        previewCanvas: preview ? document.getElementById('frontTex') : null,
        preview,
        activeA: aActive,
        activeB: bActive,
        flipY: true
      });
      const [cntA, xA, yA] = a;
      const [cntB, xB, yB] = b;
      const hits = [];
      if (cntA > cfg.frontMinArea) {
        hits.push({ team: cfg.teamA, x: xA / cfg.frontResW, y: yA / cfg.frontResH });
      }
      if (cntB > cfg.frontMinArea) {
        hits.push({ team: cfg.teamB, x: xB / cfg.frontResW, y: yB / cfg.frontResH });
      }
      if (preview && hits.length) {
        for (const h of hits) PreviewGfx.drawHit(h);
      }
      return { detected: hits.length > 0, hits };
    } finally {
      frontRunning = false;
    }
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
