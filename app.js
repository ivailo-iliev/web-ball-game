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

// Camera runs at 19.5:9 (1920×886). Crop width is configurable but
// height always maintains the aspect ratio.
const CAM_W = 1920;
const CAM_H = 886;
const ASPECT = CAM_H / CAM_W;
const DEFAULT_CROP_W = 1280;
// iOS Safari requires even crop sizes when using VideoFrame visibleRect.
// Round and mask off the lowest bit to guarantee an even height.
const DEFAULT_CROP_H = Math.round(DEFAULT_CROP_W * ASPECT) & ~1;
const DEFAULT_ZOOM = CAM_W / DEFAULT_CROP_W;

const DEFAULTS = {
  topResW: 640,
  topResH: 480,
  frontZoom: DEFAULT_ZOOM,
  frontResW: DEFAULT_CROP_W,
  frontResH: DEFAULT_CROP_H,
  topMinArea: 0.025,   // seed score threshold (0..1), was "area"
  frontMinArea: 8000,  // no longer used for decisions, kept for UI compatibility
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
  topH:   160,
  frontH: 220,
  topMode: TOP_MODE_WEBRTC
};

const Config = createConfig(DEFAULTS);
Config.load();
const cfgInit = Config.get();
cfgInit.frontResW = Math.round(CAM_W / (cfgInit.frontZoom || DEFAULT_ZOOM)) & ~1;
cfgInit.frontResH = Math.round(cfgInit.frontResW * ASPECT) & ~1;

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


const Detect = (() => {
  const cfg = Config.get();

  function rectTop() {
    const ys = cfg.polyT.map(p => p[1]);
    return {
      min: new Float32Array([0, Math.min(...ys)]),
      max: new Float32Array([cfg.topResW, Math.max(...ys)])
    };
  }

  function rectFront() {
    if (cfg.polyF.length !== 4) {
      return { min: new Float32Array([0, 0]), max: new Float32Array([cfg.frontResW, cfg.frontResH]) };
    }
    const xs = cfg.polyF.map(p => p[0]);
    const ys = cfg.polyF.map(p => p[1]);
    return {
      min: new Float32Array([Math.min(...xs), Math.min(...ys)]),
      max: new Float32Array([Math.max(...xs), Math.max(...ys)])
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
    // a[0]/b[0] are Best.key (Q16 score in high 16 bits)
    const scoreA = (a[0] >>> 16) / 65535;
    const scoreB = (b[0] >>> 16) / 65535;
    const presentA = scoreA >= cfg.topMinArea;
    const presentB = scoreB >= cfg.topMinArea;
    return { presentA, presentB, scoreA, scoreB };
  }

  let frontRunning = false;
  async function runFrontDetection(aActive, bActive, preview) {
    if (frontRunning) return { detected: false, hits: [] };
    frontRunning = true;
    let frame;
    try {
      frame = await Feeds.frontFrame();
      if (!frame) return { detected: false, hits: [] };
      const canvas = preview ? document.getElementById('frontTex') : null;
      const colorA = TEAM_INDICES[cfg.teamA];
      const colorB = TEAM_INDICES[cfg.teamB];
      const { a, b, w, h, resized } = await GPUShared.detect({
        key: 'front',
        source: frame,
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
        previewCanvas: canvas,
        preview,
        activeA: aActive,
        activeB: bActive,
        flipY: true
      });
      if (resized && canvas) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      const [keyA, xA, yA] = a;
      const [keyB, xB, yB] = b;
      const hits = [];
      if (aActive && keyA !== 0) {
        hits.push({ team: cfg.teamA, x: xA / cfg.frontResW, y: yA / cfg.frontResH });
      }
      if (bActive && keyB !== 0) {
        hits.push({ team: cfg.teamB, x: xB / cfg.frontResW, y: yB / cfg.frontResH });
      }
      if (preview && hits.length) {
        for (const h of hits) PreviewGfx.drawHit(h);
      }
      return { detected: hits.length > 0, hits };
    } finally {
      if (frame) frame.close();
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

    const { presentA, presentB } = await Detect.runTopDetection(preview);
    if (presentA || presentB) {
      const aActive = presentA;
      const bActive = presentB;
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
    const cfg = Config.get();
    Setup.updateFrontCrop();
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
window.Config = Config;
window.PreviewGfx = PreviewGfx;
window.Detect = Detect;
window.Controller = Controller;
Controller.start();
})();
