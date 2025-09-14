// app.js – dual-camera WebGPU detection with throttled setup and one-shot front processing
// ------------------------------------------------------------------------------
// * Continuous WebGPU detection on MJPEG "top" feed
// * One-shot WebGPU detection on device-camera "front" feed upon impact
// * Identical pipeline in setup (throttled) and live (triggered)

(function () {
  'use strict';

  const Config = window.Config;
  const TEAM_INDICES = window.TEAM_INDICES;

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
    ensure2d();
    const ctx = which === 'front' ? ctxFront2d : ctxTop2d;
    if (!ctx) return;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (!rect) return;
    const x = Math.floor(rect.x || 0);
    const y = Math.floor(rect.y || 0);
    const w = Math.floor(rect.w || ctx.canvas.width);
    const h = Math.floor(rect.h || ctx.canvas.height);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
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

  // function view(device, which) {
  //   ensureGPU(device);
  //   const ctx = which === 'front' ? ctxFrontGPU : ctxTopGPU;
  //   return ctx ? ctx.getCurrentTexture().createView() : null;
  // }

  return { /*view,*/ drawRect, drawHit, clear };
})();


const Detect = (() => {
  const cfg = Config.get();

  function rectTop() {
    const r = cfg.topRect || {};
    const x0 = Math.max(0, Math.floor(r.x || 0));
    const y0 = Math.max(0, Math.floor(r.y || 0));
    const x1 = Math.min(cfg.topResW, Math.floor((r.x || 0) + (r.w || cfg.topResW)));
    const y1 = Math.min(cfg.topResH, Math.floor((r.y || 0) + (r.h || cfg.topResH)));
    return {
      min: new Float32Array([x0, y0]),
      max: new Float32Array([x1, y1])
    };
  }

  function rectFront() {
    const r = cfg.frontRect || {};
    const x0 = Math.max(0, Math.floor(r.x || 0));
    const y0 = Math.max(0, Math.floor(r.y || 0));
    const x1 = Math.min(cfg.frontResW, Math.floor((r.x || 0) + (r.w || cfg.frontResW)));
    const y1 = Math.min(cfg.frontResH, Math.floor((r.y || 0) + (r.h || cfg.frontResH)));
    return {
      min: new Float32Array([x0, y0]),
      max: new Float32Array([x1, y1])
    };
  }

  async function init() {
    // all GPU checks/device creation removed
    // rely on GPU.detect to throw if unsupported
    return true;
  }
    async function runTopDetection(preview) {
    const colorA = TEAM_INDICES[cfg.teamA];
    const colorB = TEAM_INDICES[cfg.teamB];
    const { a, b } = await GPU.detect({
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
        previewCanvas: preview ? $('#topTex') : null,
      preview,
      activeA: true,
      activeB: true
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
        const colorA = TEAM_INDICES[cfg.teamA];
      const colorB = TEAM_INDICES[cfg.teamB];
      const { a, b, w, h, resized } = await GPU.detect({
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
          previewCanvas: preview ? $('#frontTex') : null,
        preview,
        activeA: aActive,
        activeB: bActive
      });
        if (resized && $('#frontTex')) {
          $('#frontTex').width = frame.displayWidth;
          $('#frontTex').height = frame.displayHeight;
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
    if (Config.get().topMode === 0) {
      RTC.startB();
    }
    if (!await Feeds.init()) return;
    if (!await Detect.init()) return;
    lastTop = 0;
    if (Config.get().topMode === 1) {
      requestAnimationFrame(topLoop);
    }
  }

  Controller.start = start;
  Controller.handleBit = handleBit;
  return Controller;
})();
window.PreviewGfx = { drawRect: PreviewGfx.drawRect };
window.Controller = {
  handleBit: Controller.handleBit,
  get isPreview() { return Controller.isPreview; },
  set isPreview(v) { Controller.isPreview = v; }
};
Controller.start();
})();
