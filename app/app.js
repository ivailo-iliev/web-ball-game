// app.js – dual-camera WebGPU detection with throttled setup and one-shot front processing
// ------------------------------------------------------------------------------
// * Continuous WebGPU detection on MJPEG "top" feed
// * One-shot WebGPU detection on device-camera "front" feed upon impact
// * Identical pipeline in setup (throttled) and live (triggered)

(function () {
  'use strict';

  const PreviewGfx = (() => {
  let ctxTop2d, ctxFront2d, ctxTopGPU, ctxFrontGPU;

  function ensure2d() {
    if (!ctxTop2d) ctxTop2d = $('#topOv')?.getContext('2d');
    if (!ctxFront2d) ctxFront2d = $('#frontOv')?.getContext('2d');
  }

  function ensureGPU(device) {
    if (!device) return;
    if (!ctxTopGPU) {
        try {
          ctxTopGPU = $('#topTex')?.getContext?.('webgpu');
          ctxTopGPU?.configure({ device, format: 'rgba8unorm', alphaMode: 'opaque' });
        } catch (err) {
          console.log('Top canvas WebGPU init failed', err);
          ctxTopGPU = null;
        }
    }
    if (!ctxFrontGPU) {
        try {
          ctxFrontGPU = $('#frontTex')?.getContext?.('webgpu');
          ctxFrontGPU?.configure({ device, format: 'rgba8unorm', alphaMode: 'opaque' });
        } catch (err) {
          console.log('Front canvas WebGPU init failed', err);
          ctxFrontGPU = null;
        }
    }
  }

  function clear() {
    ensure2d();
    if (ctxTop2d) ctxTop2d.clearRect(0, 0, ctxTop2d.canvas.width, ctxTop2d.canvas.height);
    if (ctxFront2d) ctxFront2d.clearRect(0, 0, ctxFront2d.canvas.width, ctxFront2d.canvas.height);
  }

  function drawRect(rect, color, which) {
    if (!window.Controller?.isPreview) return;
    ensure2d();
    const ctx = which === 'front' ? ctxFront2d : ctxTop2d;
    if (!ctx) return;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (!rect) return;
    const { x, y, w, h } = rect;
    if (![x, y, w, h].every(Number.isFinite)) return;
    if (w <= 0 || h <= 0) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(Math.floor(x), Math.floor(y), Math.floor(w), Math.floor(h));
  }

  function drawHit(hit) {
    if (!window.Controller?.isPreview) return;
    ensure2d();
    if (!ctxFront2d) return;
    const cfg = window.cfg;
    if (!cfg) return;
    const { frontResW, frontResH } = cfg;
    ctxFront2d.fillStyle = hit.team;
    const px = hit.x * frontResW, py = hit.y * frontResH;
    ctxFront2d.beginPath();
    ctxFront2d.arc(px, py, 8, 0, Math.PI * 2);
    ctxFront2d.fill();
  }

  // function view(device, which) {
  //   ensureGPU(device);
  //   const ctx = which === 'front' ? ctxFrontGPU : ctxTopGPU;
  //   return ctx ? ctx.getCurrentTexture().createView() : null;
  // }

  return { /*view,*/ drawRect, drawHit, clear };
})();


  const Detect = (() => {

  async function init() {
    // all GPU checks/device creation removed
    // rely on GPU.detect to throw if unsupported
    return true;
  }
  async function runTopDetection(preview) {
    const cfg = window.cfg;
    if (!cfg) return { presentA: false, presentB: false, scoreA: 0, scoreB: 0 };
    const colorA = cfg.colorA;
    const colorB = cfg.colorB;
    const { a, b } = await GPU.detect({
      key: 'top',
      source: Feeds.top(),
      colorA,
      colorB,
      refine: false,
      domThrA: cfg.domThrA,
      satMinA: cfg.satMinA,
      yMinA: cfg.yMinA,
      yMaxA: cfg.yMaxA,
      domThrB: cfg.domThrB,
      satMinB: cfg.satMinB,
      yMinB: cfg.yMinB,
      yMaxB: cfg.yMaxB,
      radiusPx: cfg.radiusPx,
      rect: cfg.topRectMM,   // may be null -> full-frame inside detect.js
      previewCanvas: preview ? $('#topTex') : null,
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
    const cfg = window.cfg;
    if (!cfg) return { detected: false, hits: [] };
    frontRunning = true;
    let frame;
    try {
      frame = await Feeds.frontFrame();
      if (!frame) return { detected: false, hits: [] };
      const colorA = cfg.colorA;
      const colorB = cfg.colorB;
      const frontRect = cfg.frontRectMM;
      const validFrontRect = frontRect?.min && frontRect?.max &&
        frontRect.max[0] > frontRect.min[0] &&
        frontRect.max[1] > frontRect.min[1];
      const { a, b, w, h, resized } = await GPU.detect({
        key: 'front',
        source: frame,
        colorA,
        colorB,
        refine: true,
        domThrA: cfg.domThrA,
        satMinA: cfg.satMinA,
        yMinA: cfg.yMinA,
        yMaxA: cfg.yMaxA,
        domThrB: cfg.domThrB,
        satMinB: cfg.satMinB,
        yMinB: cfg.yMinB,
        yMaxB: cfg.yMaxB,
        radiusPx: cfg.radiusPx,
        rect: validFrontRect ? frontRect : null,  // may be null -> full-frame inside detect.js
        previewCanvas: preview ? $('#frontTex') : null,
        preview,
        activeA: aActive,
        activeB: bActive,
        flipY: true
      });
      if (resized && $('#frontTex')) {
        $('#frontTex').width = frame.displayWidth;
        $('#frontTex').height = frame.displayHeight;
      }
      const [keyA, xA, yA] = a;
      const [keyB, xB, yB] = b;
      const hits = [];
      if (aActive && keyA !== 0) {
        const { teamA, frontResW, frontResH } = cfg;
        hits.push({ team: teamA, x: xA / frontResW, y: yA / frontResH });
      }
      if (bActive && keyB !== 0) {
        const { teamB, frontResW, frontResH } = cfg;
        hits.push({ team: teamB, x: xB / frontResW, y: yB / frontResH });
      }
      if (preview && hits.length && window.Controller?.isPreview) {
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
    const TOP_FPS = 30;               // throttle only the MJPEG-top feed
    const TOP_INTERVAL = 1000 / TOP_FPS;
    let lastTop = 0;
    const Controller = { isPreview: false };


  async function topLoop(ts) {
    if (ts - lastTop < TOP_INTERVAL) {
      requestAnimationFrame(topLoop);
      return;
    }
    lastTop = ts;

    const { presentA, presentB } = await Detect.runTopDetection(Controller.isPreview);
    if (presentA || presentB) {
      const aActive = presentA;
      const bActive = presentB;
      const { detected: frontDetected, hits } = await Detect.runFrontDetection(aActive, bActive, Controller.isPreview);

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
    const { detected: frontDetected, hits } = await Detect.runFrontDetection(aActive, bActive, Controller.isPreview);
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
    const cfg = window.cfg;
    if (!cfg) return;
    if (cfg.topMode === 0) {
      RTC.startB();
    }
    if (!await Feeds.init()) return;
    if (!await Detect.init()) return;
    lastTop = 0;
    if (cfg.topMode === 1) {
      requestAnimationFrame(topLoop);
    }
  }

  Controller.start = start;
  Controller.handleBit = handleBit;
  return Controller;
})();
window.PreviewGfx = { drawRect: PreviewGfx.drawRect, clear: PreviewGfx.clear };
window.Controller = Controller;
Controller.start();
})();
