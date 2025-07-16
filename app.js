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
const FLAG_PREVIEW = 1;   // bit 0 – you already use this
const FLAG_TEAM_A_ACTIVE = 2;   // bit 1 – set when cntA > cfg.TOP_MIN_AREA
const FLAG_TEAM_B_ACTIVE = 4;   // bit 2 – set when cntB > cfg.TOP_MIN_AREA

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
  /* red    */ 0.00, 0.5, 0.7, 0.10, 1.00, 1.00,
  /* yellow */ 0.10, 0.5, 0.5, 0.20, 1.00, 1.00,
  /* blue   */ 0.50, 0.4, 0.4, 0.70, 1.00, 1.00,
  /* green  */ 0.70, 0.2, 0.2, 0.90, 1.00, 1.00
]);
function hsvRange(team) {
  const i = TEAM_INDICES[team] * 6;
  return COLOR_TABLE.subarray(i, i + 6);
}

function float32ToFloat16(val) {
  const f32 = new Float32Array([val]);
  const u32 = new Uint32Array(f32.buffer)[0];
  const sign = (u32 >> 16) & 0x8000;
  let exp = ((u32 >> 23) & 0xFF) - 127 + 15;
  let mant = u32 & 0x7FFFFF;
  if (exp <= 0) return sign;
  if (exp >= 0x1F) return sign | 0x7C00;
  return sign | (exp << 10) | (mant >> 13);
}

function hsvRangeF16(team) {
  const src = hsvRange(team);
  const dst = new Uint16Array(6);
  for (let i = 0; i < 6; i++) dst[i] = float32ToFloat16(src[i]);
  return dst;
}

/* DOM helper with simple caching */
const domCache = {};
const $ = sel => domCache[sel] || (domCache[sel] = document.querySelector(sel));

const Config = (() => {
  const DEFAULTS = {
    TOP_W: 640,
    TOP_H: 480,
    FRONT_W: 1280,
    FRONT_H: 590,
    TOP_MIN_AREA: 600,
    FRONT_MIN_AREA: 50000,
    url:    "http://192.168.43.1:8080/video",
    teamA:  "green",
    teamB:  "blue",
    polyT:  [],
    polyF:  [],
    zoom:   1.0,
    topH:   160,
    frontH: 220
  };

  const PERSIST = {
    url:    "frontURL",
    teamA:  "teamA",
    teamB:  "teamB",
    polyT:  "roiPolyTop",
    polyF:  "roiPolyFront",
    zoom:   "zoom",
    topH:   "topH",
    frontH: "frontH",
    TOP_MIN_AREA: "topMinArea",
    FRONT_MIN_AREA: "frontMinArea"
  };

  let cfg;

  function load() {
    cfg = {};
    for (const [name, def] of Object.entries(DEFAULTS)) {
      if (PERSIST[name]) {
        const raw = localStorage.getItem(PERSIST[name]);
        cfg[name] = raw !== null ? JSON.parse(raw) : def;
      } else {
        cfg[name] = def;
      }
    }
    cfg.f16Ranges = {};
    for (const t of Object.keys(TEAM_INDICES)) {
      cfg.f16Ranges[t] = hsvRangeF16(t);
    }
    return cfg;
  }

  function save(name, value) {
    if (PERSIST[name]) {
      localStorage.setItem(PERSIST[name], JSON.stringify(value));
    }
    if (cfg) {
      cfg[name] = value;
    }
  }

  function get() { return cfg; }

  return { load, save, get };
})();

Config.load();

const PreviewGfx = (() => {
  const cfg = Config.get();
  let ctxTop2d, ctxFront2d, ctxTopGPU, ctxFrontGPU;

  function ensure2d() {
    if (!ctxTop2d) ctxTop2d = $('#topOv')?.getContext('2d');
    if (!ctxFront2d) ctxFront2d = $('#frontOv')?.getContext('2d');
  }

  function ensureGPU(device) {
    if (!ctxTopGPU) {
      const c = $('#topTex');
      if (c) {
        ctxTopGPU = c.getContext('webgpu');
        ctxTopGPU.configure({ device, format: 'rgba8unorm' });
      }
    }
    if (!ctxFrontGPU) {
      const c = $('#frontTex');
      if (c) {
        ctxFrontGPU = c.getContext('webgpu');
        ctxFrontGPU.configure({ device, format: 'rgba8unorm' });
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

  function drawMask(enc, pipe, bg, device, which) {
    ensureGPU(device);
    const ctx = which === 'front' ? ctxFrontGPU : ctxTopGPU;
    if (!ctx) return;
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }]
    });
    rp.setPipeline(pipe);
    rp.setBindGroup(0, bg);
    rp.draw(3);
    rp.end();
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
    <input type="range" id="zoomSlider" style="width: 100%;">
    Top H <input id=topHInp   type=number min=10 max=${cfg.TOP_H}   step=1 style="width:5em">
    Front H <input id=frontHInp type=number min=10 max=${cfg.FRONT_H} step=1 style="width:5em">
    Top Min <input id=topMinInp   type=number min=0 step=25 style="width:6em">
    Front Min <input id=frontMinInp type=number min=0 step=100 style="width:6em">
    <button id=btnTop>Top</button>
    <button id=btnFront>Front</button>
    <button id=btnBoth>Both</button>
    IP-Cam URL <input id=url size=32>
    Team A <select id=a>${Object.keys(TEAM_INDICES).map(c => `<option>${c}</option>`).join('')}</select>
    Team B <select id=b>${Object.keys(TEAM_INDICES).map(c => `<option>${c}</option>`).join('')}</select>
    <button onclick="location.reload()">Refresh</button>
  </div>`;

  function bind() {
    $('#configScreen').insertAdjacentHTML('beforeend', detectionUI);
    const urlI = $('#url');
    const selA = $('#a');
    const selB = $('#b');
    const topOv = $('#topOv');
    const frontOv = $('#frontOv');
    const zoomSlider = $('#zoomSlider');
    const btnTop   = $('#btnTop');
    const btnFront = $('#btnFront');
    const btnBoth  = $('#btnBoth');

    const cfgScreen = $('#configScreen');
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

      topHInp.onchange = e => {
        cfg.topH = Math.max(10, Math.min(cfg.TOP_H, +e.target.value));
        Config.save('topH', cfg.topH);
        topROI.h = cfg.topH;
        commitTop();
      };
      frontHInp.onchange = e => {
        cfg.frontH = Math.max(10, Math.min(cfg.FRONT_H, +e.target.value));
        Config.save('frontH', cfg.frontH);
        roi.h = cfg.frontH;
        roi.w = roi.h * ASPECT;
        commit();
      };
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

    urlI.onblur = () => { cfg.url = urlI.value; Config.save('url', cfg.url); };
    selA.onchange = e => {
      cfg.teamA = e.target.value;
      Config.save('teamA', cfg.teamA);
      Game.setTeams(cfg.teamA, cfg.teamB);
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
  let videoTop, videoFront, track;

  async function init() {
    videoFront = $('#vid');

    videoTop = new Image();
    videoTop.crossOrigin = 'anonymous';
    videoTop.src = cfg.url;
    await videoTop.decode();

    const frontStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { exact: cfg.FRONT_W },
        height: { exact: cfg.FRONT_H },
        facingMode: 'environment',
        frameRate: { ideal: 60, max: 120 }
      }
    });

    videoFront.srcObject = frontStream;
    track = frontStream.getVideoTracks()[0];
    await videoFront.play();

    const cap = track.getCapabilities();
    const adv = {};

    if (cap.powerEfficient) adv.powerEfficient = false;

    if (cap.zoom) {
      const zoomSlider = $('#zoomSlider');
      const { min, max, step } = cap.zoom;
      zoomSlider.min = min;
      zoomSlider.max = Math.min(2, max);
      zoomSlider.step = step || 0.1;
      zoomSlider.value = cfg.zoom;
      zoomSlider.addEventListener('input', async () => {
        adv.zoom = parseFloat(zoomSlider.value);
        cfg.zoom = adv.zoom;
        Config.save('zoom', cfg.zoom);
        try {
          await track.applyConstraints({ advanced: [adv] });
        } catch (err) {
          console.error('Zoom apply failed:', err);
        }
      });
    }

    if (Object.keys(adv).length) {
      await track.applyConstraints({ advanced: [adv] });
    }
  }

  return {
    init,
    top: () => videoTop,
    front: () => videoFront
  };
})();

const Detect = (() => {
  const cfg = Config.get();
  /* GPU globals */
  let device;
  let frameTex1, maskTex1, frameTex2, maskTex2, sampler;
  let uni, statsA, statsB, readA, readB;
  let pipeC, pipeQ, bgR, bgRF, bgTop, bgFront;
  const zero = new Uint32Array([0, 0, 0]);


  // Pre-allocate uniform buffer and typed-array views (64 bytes)
  const uniformArrayBuffer = new ArrayBuffer(64);
  const uniformU16 = new Uint16Array(uniformArrayBuffer);
  const uniformF32 = new Float32Array(uniformArrayBuffer);
  const uniformU32 = new Uint32Array(uniformArrayBuffer);

  function writeUniform(buf, hsvA6, hsvB6, rect, flags) {
    const u16 = uniformU16;
    const f32 = uniformF32;
    const u32 = uniformU32;

    for (let i = 0; i < 3; i++) u16[i] = hsvA6[i];
    for (let i = 0; i < 3; i++) u16[4 + i] = hsvA6[i + 3];
    for (let i = 0; i < 3; i++) u16[8 + i] = hsvB6[i];
    for (let i = 0; i < 3; i++) u16[12 + i] = hsvB6[i + 3];
    f32[8] = rect.min[0]; f32[9] = rect.min[1];
    f32[10] = rect.max[0]; f32[11] = rect.max[1];
    u32[12] = flags;
    device.queue.writeBuffer(buf, 0, uniformArrayBuffer);
  }

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

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    const hasF16 = adapter.features.has("shader-f16");
    device = await adapter.requestDevice({ requiredFeatures: hasF16 ? ["shader-f16"] : [] });
    console.log("shader-f16:", hasF16);

    const texUsage1 = GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
    const maskUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST;
    frameTex1 = device.createTexture({ size: [cfg.TOP_W, cfg.TOP_H], format: 'rgba8unorm', usage: texUsage1 });
    maskTex1 = device.createTexture({ size: [cfg.TOP_W, cfg.TOP_H], format: 'rgba8unorm', usage: maskUsage });
    frameTex2 = device.createTexture({ size: [cfg.FRONT_W, cfg.FRONT_H], format: 'rgba8unorm', usage: texUsage1 });
    maskTex2 = device.createTexture({ size: [cfg.FRONT_W, cfg.FRONT_H], format: 'rgba8unorm', usage: maskUsage });
    sampler = device.createSampler();

    uni = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    statsA = device.createBuffer({ size: 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    statsB = device.createBuffer({ size: 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    readA = device.createBuffer({ size: 12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    readB = device.createBuffer({ size: 12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    const code = await fetch('shader.wgsl').then(r => r.text());
    const mod = device.createShaderModule({ code });
    pipeC = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
    pipeQ = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs' },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' }
    });

    bgR = device.createBindGroup({ layout: pipeQ.getBindGroupLayout(0), entries: [
      { binding: 0, resource: frameTex1.createView() },
      { binding: 4, resource: maskTex1.createView() },
      { binding: 5, resource: sampler }
    ] });
    bgRF = device.createBindGroup({ layout: pipeQ.getBindGroupLayout(0), entries: [
      { binding: 0, resource: frameTex2.createView() },
      { binding: 4, resource: maskTex2.createView() },
      { binding: 5, resource: sampler }
    ] });
    bgTop = device.createBindGroup({
      layout: pipeC.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: frameTex1.createView() },
        { binding: 1, resource: maskTex1.createView() },
        { binding: 2, resource: { buffer: statsA } },
        { binding: 3, resource: { buffer: statsB } },
        { binding: 6, resource: { buffer: uni } }
      ]
    });
    bgFront = device.createBindGroup({
      layout: pipeC.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: frameTex2.createView() },
        { binding: 1, resource: maskTex2.createView() },
        { binding: 2, resource: { buffer: statsA } },
        { binding: 3, resource: { buffer: statsB } },
        { binding: 6, resource: { buffer: uni } }
      ]
    });
  }

  async function runTopDetection(preview) {
    device.queue.writeBuffer(statsA, 0, zero);
    device.queue.writeBuffer(statsB, 0, zero);

    const srcY = Math.floor((Feeds.top().naturalHeight - cfg.TOP_H) / 2);
    device.queue.copyExternalImageToTexture(
      { source: Feeds.top(), origin: { x: 0, y: srcY } },
      { texture: frameTex1 },
      [cfg.TOP_W, cfg.TOP_H]
    );

    const enc = device.createCommandEncoder();
    enc.beginRenderPass({ colorAttachments: [{ view: maskTex1.createView(), loadOp: 'clear', storeOp: 'store' }] }).end();

    const flagsTop = (preview ? FLAG_PREVIEW : 0) | FLAG_TEAM_A_ACTIVE | FLAG_TEAM_B_ACTIVE;
    writeUniform(uni, cfg.f16Ranges[cfg.teamA], cfg.f16Ranges[cfg.teamB], rectTop(), flagsTop);
    let cp = enc.beginComputePass();
    cp.setPipeline(pipeC);
    cp.setBindGroup(0, bgTop);
    cp.dispatchWorkgroups(Math.ceil(cfg.TOP_W / 8), Math.ceil(cfg.TOP_H / 32));
    cp.end();
    enc.copyBufferToBuffer(statsA, 0, readA, 0, 12);
    enc.copyBufferToBuffer(statsB, 0, readB, 0, 12);
    if (preview) {
      PreviewGfx.drawMask(enc, pipeQ, bgR, device, 'top');
    }
    device.queue.submit([enc.finish()]);
    await Promise.all([readA.mapAsync(GPUMapMode.READ), readB.mapAsync(GPUMapMode.READ)]);
    const [cntA] = new Uint32Array(readA.getMappedRange());
    readA.unmap();
    const [cntB] = new Uint32Array(readB.getMappedRange());
    readB.unmap();

    const topDetected = cntA > cfg.TOP_MIN_AREA || cntB > cfg.TOP_MIN_AREA;
    return { detected: topDetected, cntA, cntB };
  }

  let lastCaptureTime = 0;
  async function runFrontDetection(flags, preview) {
    const meta = await new Promise(res => Feeds.front().requestVideoFrameCallback((_n, m) => res(m)));
    if (meta.captureTime === lastCaptureTime) return { detected: false, hits: [] };
    lastCaptureTime = meta.captureTime;

    device.queue.writeBuffer(statsA, 0, zero);
    device.queue.writeBuffer(statsB, 0, zero);

    device.queue.copyExternalImageToTexture(
      { source: Feeds.front() },
      { texture: frameTex2 },
      [cfg.FRONT_W, cfg.FRONT_H]
    );
    const enc2 = device.createCommandEncoder();
    enc2.beginRenderPass({ colorAttachments: [{ view: maskTex2.createView(), loadOp: 'clear', storeOp: 'store' }] }).end();
    writeUniform(uni, cfg.f16Ranges[cfg.teamA], cfg.f16Ranges[cfg.teamB], rectFront(), flags);
    let cp2 = enc2.beginComputePass();
    cp2.setPipeline(pipeC);
    cp2.setBindGroup(0, bgFront);
    cp2.dispatchWorkgroups(Math.ceil(cfg.FRONT_W / 8), Math.ceil(cfg.FRONT_H / 32));
    cp2.end();
    enc2.copyBufferToBuffer(statsA, 0, readA, 0, 12);
    enc2.copyBufferToBuffer(statsB, 0, readB, 0, 12);
    if (preview) {
      PreviewGfx.drawMask(enc2, pipeQ, bgRF, device, 'front');
    }
    device.queue.submit([enc2.finish()]);

    await Promise.all([readA.mapAsync(GPUMapMode.READ), readB.mapAsync(GPUMapMode.READ)]);
    const [cntA, sumXA, sumYA] = new Uint32Array(readA.getMappedRange());
    readA.unmap();
    const [cntB, sumXB, sumYB] = new Uint32Array(readB.getMappedRange());
    readB.unmap();

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
      for (const h of hits) {
        PreviewGfx.drawHit(h);
      }
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
          Game.doHit(
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

  async function start() {
    Setup.bind();
    await Feeds.init();
    await Detect.init();
    lastTop = 0;
    requestAnimationFrame(topLoop);
  }

  function setPreview(on) { preview = on; }
  function isPreview() { return preview; }

  return { start, setPreview, isPreview };
})();
window.App = { Config, PreviewGfx, Setup, Feeds, Detect, Controller };
Controller.start();
})();
