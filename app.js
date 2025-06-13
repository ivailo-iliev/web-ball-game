// app.js – dual-camera WebGPU detection with throttled setup and one-shot front processing
// ------------------------------------------------------------------------------
// * Continuous WebGPU detection on MJPEG "top" feed
// * One-shot WebGPU detection on device-camera "front" feed upon impact
// * Identical pipeline in setup (throttled) and live (triggered)

/* ---------------- CONSTANTS ---------------- */
// ——————— CONSTANTS ———————
// top-camera MJPEG feed (over Wi-Fi)
const TOP_W = 640;
const TOP_H = 480;
const TOP_MIN_AREA = 600;
const FLAG_PREVIEW = 1;   // bit 0 – you already use this
const FLAG_TEAM_A_ACTIVE = 2;   // bit 1 – set when cntA > TOP_MIN_AREA
const FLAG_TEAM_B_ACTIVE = 4;   // bit 2 – set when cntB > TOP_MIN_AREA

// front-camera (device camera)
const FRONT_W = 1280;
const FRONT_H = 590;
const FRONT_MIN_AREA = 50000;

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

/* DOM helper */
const $ = q => document.querySelector(q);

// Consolidated config: LS key + default in one place
const CONFIG = {
  url: { key: "frontURL", def: "http://192.168.43.1:8080/video" },
  teamA: { key: "teamA", def: "green" },
  teamB: { key: "teamB", def: "blue" },
  polyT: { key: "roiPolyTop", def: [] },
  polyF: { key: "roiPolyFront", def: [] },
  zoom: { key: "zoom", def: 1.0 },
  topH: { key: "topH", def: 160 },       // NEW  – px height of the top rectangle
  frontH: { key: "frontH", def: 220 }      // NEW  – px height of the front rectangle
};

const Config = (() => {
  function load(name) {
    const { key, def } = CONFIG[name];
    const raw = localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : def;
  }
  function save(name, value) {
    localStorage.setItem(CONFIG[name].key, JSON.stringify(value));
    params[name] = value;
  }
  return { load, save };
})();

const params = {
  url: Config.load("url"),
  teamA: Config.load("teamA"),
  teamB: Config.load("teamB"),
  polyT: Config.load("polyT"),   // 4 points for the top camera
  polyF: Config.load("polyF"),   // 2 or 4 points for the front camera
  zoom: Config.load("zoom"),
  topH: Config.load("topH"),               // NEW
  frontH: Config.load("frontH"),             // NEW
  preview: false                 // setup mode
};

/* Build UI */
const detectionUI = `
<div class=cam id=topCam>
  <canvas id=topTex width=${TOP_W} height=${TOP_H}></canvas>
  <canvas id=topOv class=overlay width=${TOP_W} height=${TOP_H}></canvas>
</div>
<div class=cam id=frontCam>
 <video id=vid autoplay playsinline style="display: none;"></video>
 <canvas id="frontTex" width=${FRONT_W} height=${FRONT_H}></canvas>
 <canvas id=frontOv  class=overlay width=${FRONT_W} height=${FRONT_H}></canvas>
</div>
<div id=cfg>
  <input type="range" id="zoomSlider" style="width: 100%;">
  Top H <input id=topHInp   type=number min=10 max=${TOP_H}   step=1 style="width:5em">
  Front H <input id=frontHInp type=number min=10 max=${FRONT_H} step=1 style="width:5em">
  <button onclick="$('#configScreen').className = 'onlyTop'">Top</button>
  <button onclick="$('#configScreen').className = 'onlyFront'">Front</button>
  <button onclick="$('#configScreen').className = ''">Both</button>
  IP-Cam URL <input id=url size=32>
  Team A <select id=a>${Object.keys(TEAM_INDICES).map(c => `<option>${c}</option>`).join('')}</select>
  Team B <select id=b>${Object.keys(TEAM_INDICES).map(c => `<option>${c}</option>`).join('')}</select>
  <button onclick="location.reload()">Refresh</button>
</div>`;
$('#configScreen').insertAdjacentHTML('beforeend', detectionUI);
/* Wire UI */
const urlI = $('#url');
const selA = $('#a'), selB = $('#b');
const topOv = $('#topOv'),
  frontOv = $('#frontOv');
const frontCtx = frontOv.getContext("2d");
const topCtx = topOv.getContext("2d");
const zoomSlider = $('#zoomSlider');

const Feeds = (() => {
  let videoTop, videoFront, track;

  async function init() {
    videoFront = document.getElementById('vid');

    videoTop = new Image();
    videoTop.crossOrigin = 'anonymous';
    videoTop.src = params.url;
    await videoTop.decode();

    const frontStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { exact: FRONT_W },
        height: { exact: FRONT_H },
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
      const { min, max, step } = cap.zoom;
      zoomSlider.min = min;
      zoomSlider.max = Math.min(2, max);
      zoomSlider.step = step || 0.1;
      zoomSlider.value = params.zoom;
      zoomSlider.addEventListener('input', async () => {
        adv.zoom = parseFloat(zoomSlider.value);
        params.zoom = adv.zoom;
        Config.save('zoom', params.zoom);
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

/** reorder any 4 points into [TR, TL, BL, BR] (CCW) */
function orderPoints(pts) {
  const arr = pts.map(p => [...p]);
  // TR = max(x−y), BL = min(x−y)
  let tr = 0, bl = 0, mx = arr[0][0] - arr[0][1], mn = mx;
  arr.forEach((p, i) => {
    const v = p[0] - p[1];
    if (v > mx) { mx = v; tr = i; }
    if (v < mn) { mn = v; bl = i; }
  });
  // the other two are TL/BR; TL=min(x+y)
  const rem = [0, 1, 2, 3].filter(i => i !== tr && i !== bl);
  const [a, b] = rem;
  const sumA = arr[a][0] + arr[a][1], sumB = arr[b][0] + arr[b][1];
  const tl = sumA < sumB ? a : b;
  const br = rem.find(i => i !== tl);
  return [arr[tl], arr[tr], arr[br], arr[bl]];
}

/** single canvas polygon drawer */
function drawPolygon(ctx, pts, color) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (pts.length !== 4) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(...pts[0]);
  pts.slice(1).forEach(p => ctx.lineTo(...p));
  ctx.closePath();
  ctx.stroke();
}

function drawPolyTop() { drawPolygon(topCtx, params.polyT, "lime"); }
function drawPolyFront() { drawPolygon(frontCtx, params.polyF, "aqua"); }

/* ─────────── TOP ROI  (full-width rectangle, vertical drag) ─────────── */
const topROI = { y: 0, h: params.topH };            // state

function commitTop() {
  // clamp within canvas
  topROI.y = Math.min(Math.max(0, topROI.y), TOP_H - topROI.h);

  // build the four rectangle corners → params.polyT
  const { y, h } = topROI;
  params.polyT = [[0, y], [TOP_W, y], [TOP_W, y + h], [0, y + h]];
  Config.save("polyT", params.polyT);
  drawPolyTop();
}

/* vertical drag on overlay */
let dragY = null;
topOv.addEventListener("pointerdown", e => {
  if (!params.preview) return;
  const r = topOv.getBoundingClientRect();
  dragY = (e.clientY - r.top) * TOP_H / r.height;
  topOv.setPointerCapture(e.pointerId);
});
topOv.addEventListener("pointermove", e => {
  if (dragY == null || !params.preview) return;
  const r = topOv.getBoundingClientRect();
  const curY = (e.clientY - r.top) * TOP_H / r.height;
  topROI.y += curY - dragY;
  dragY = curY;
  commitTop();
});
topOv.addEventListener("pointerup", () => dragY = null);
topOv.addEventListener("pointercancel", () => dragY = null);

commitTop();       // draw once on load

(() => {
  const ASPECT = FRONT_W / FRONT_H;      // canvas ratio (e.g. 16/9)
  const MIN_W = 60;                       // min rectangle width

  /* Current rectangle — start from saved polygon if present */
  let roi = { x: 0, y: 0, w: params.frontH * ASPECT, h: params.frontH }; // NEW

  if (params.polyF?.length === 4) {
    const xs = params.polyF.map(p => p[0]), ys = params.polyF.map(p => p[1]);
    roi.x = Math.min(...xs);
    roi.y = Math.min(...ys);
    roi.w = Math.max(...xs) - roi.x;
  }

  /* Pointer-gesture state */
  const fingers = new Map();               // pointerId → {x,y}
  let startRect, startDist, startMid;

  /* Commit rectangle: clamp, persist, redraw cyan outline */
  function commit() {
    roi.w = Math.max(MIN_W, roi.w);
    roi.w = roi.h * ASPECT;

    if (roi.w > FRONT_W) { roi.w = FRONT_W; roi.h = roi.w / ASPECT; }
    if (roi.h > FRONT_H) { roi.h = FRONT_H; roi.w = roi.h * ASPECT; }

    roi.x = Math.min(Math.max(0, roi.x), FRONT_W - roi.w);
    roi.y = Math.min(Math.max(0, roi.y), FRONT_H - roi.h);

    const x0 = Math.round(roi.x), y0 = Math.round(roi.y);
    const x1 = Math.round(roi.x + roi.w), y1 = Math.round(roi.y + roi.h);
    params.polyF = orderPoints([[x1, y0], [x0, y0], [x0, y1], [x1, y1]]);
    Config.save('polyF', params.polyF);
    drawPolyFront();
  }

  /* Client → canvas coordinates */
  function toCanvas(e) {
    const r = frontOv.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * FRONT_W / r.width,
      y: (e.clientY - r.top) * FRONT_H / r.height
    };
  }

  /* ──────────── Touch-/pen-based pan & pinch (pointer events) ──────────── */
  frontOv.addEventListener('pointerdown', e => {
    if (!params.preview) return;
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
    if (!fingers.has(e.pointerId) || !params.preview) return;
    fingers.set(e.pointerId, toCanvas(e));

    if (fingers.size === 1) {                          // Pan
      const cur = [...fingers.values()][0];
      roi.x = startRect.x + (cur.x - startMid.x);
      roi.y = startRect.y + (cur.y - startMid.y);
      commit();
    }
    else if (fingers.size === 2) {                     // Pinch-zoom
      const [a, b] = [...fingers.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const scale = dist / startDist;                  // >1 ⇒ zoom-in
      roi.h = startRect.h / scale;     // NEW  – zoom changes HEIGHT
      roi.w = roi.h * ASPECT;          // NEW
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

  /* ──────────── Track-pad pinch (wheel / gesture events) ──────────── */

  /* Smooth zoom factor from wheel delta  (negative → zoom-in, positive → out) */
  function zoomFromWheel(deltaY) {
    return Math.exp(deltaY * 0.001);        // ≈ ±10% per 100px wheel delta
  }

  frontOv.addEventListener('wheel', e => {
    if (!params.preview) return;
    e.preventDefault();                     // **stop page scroll / zoom**
    const scale = zoomFromWheel(e.deltaY);
    const prevW = roi.w, prevH = roi.h;
    const newW = prevW * scale, newH = newW / ASPECT;

    roi.x -= (newW - prevW) / 2;
    roi.y -= (newH - prevH) / 2;
    roi.w = newW;
    roi.h = newH;
    commit();
  }, { passive: false });                    // passive:false => allow preventDefault()

  /* Safari: prevent default page-zoom for pinch gestures */
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(t =>
    frontOv.addEventListener(t, e => e.preventDefault())
  );

  /* Disable default touch actions on the overlay */
  frontOv.style.touchAction = 'none';
  const topHInp = $('#topHInp');
  const frontHInp = $('#frontHInp');
  topHInp.value = params.topH;
  frontHInp.value = params.frontH;

    topHInp.onchange = e => {
      params.topH = Math.max(10, Math.min(TOP_H, +e.target.value));
      Config.save("topH", params.topH);
      topROI.h = params.topH;
      commitTop();
    };
    frontHInp.onchange = e => {
      params.frontH = Math.max(10, Math.min(FRONT_H, +e.target.value));
      Config.save("frontH", params.frontH);
      roi.h = params.frontH;              // use the closure from gesture code
      roi.w = roi.h * ASPECT;
      commit();                           // re-draw front rectangle
  };

  /* Initial draw */
  commit();
})();

urlI.value = params.url;
selA.value = params.teamA;
selB.value = params.teamB;

urlI.onblur = () => { params.url = urlI.value; Config.save("url", params.url); };
selA.onchange = e => { params.teamA = e.target.value; Config.save("teamA", params.teamA); };
selB.onchange = e => { params.teamB = e.target.value; Config.save("teamB", params.teamB); };

/* GPU globals */
let device, ctxTop, ctxFront;
let frameTex1, maskTex1, frameTex2, maskTex2, sampler;
let uni, statsA, statsB, readA, readB;
let pipeC, pipeQ, bgR, bgRF, bgTop, bgFront;
const zero = new Uint32Array([0, 0, 0]);

// helper: encode a JavaScript Number (f32) into a 16-bit float bitpattern
function float32ToFloat16(val) {
  // view the same bits as a Uint32
  const f32 = new Float32Array([val]);
  const u32 = new Uint32Array(f32.buffer)[0];
  const sign = (u32 >> 16) & 0x8000;
  let exp = ((u32 >> 23) & 0xFF) - 127 + 15;
  let mant = u32 & 0x7FFFFF;

  if (exp <= 0) {
    // too small → flush to zero
    return sign;
  }
  if (exp >= 0x1F) {
    // Inf or NaN
    return sign | 0x7C00;
  }
  // pack sign + exponent + top 10 bits of mantissa
  return sign | (exp << 10) | (mant >> 13);
}


// Pre-allocate uniform buffer and typed-array views (64 bytes)
const uniformArrayBuffer = new ArrayBuffer(64);
const uniformU16 = new Uint16Array(uniformArrayBuffer);
const uniformF32 = new Float32Array(uniformArrayBuffer);
const uniformU32 = new Uint32Array(uniformArrayBuffer);

function writeUniform(buf, hsvA6, hsvB6, rect, flags) {
  // Reuse the pre-allocated uniform buffer and its views:
  const u16 = uniformU16;
  const f32 = uniformF32;
  const u32 = uniformU32;

  /* hsvA */
  for (let i = 0; i < 3; i++) u16[i] = float32ToFloat16(hsvA6[i]);
  for (let i = 0; i < 3; i++) u16[4 + i] = float32ToFloat16(hsvA6[i + 3]);
  /* hsvB */
  for (let i = 0; i < 3; i++) u16[8 + i] = float32ToFloat16(hsvB6[i]);
  for (let i = 0; i < 3; i++) u16[12 + i] = float32ToFloat16(hsvB6[i + 3]);
  /* rect (min,max) */
  f32[8] = rect.min[0]; f32[9] = rect.min[1];
  f32[10] = rect.max[0]; f32[11] = rect.max[1];
  /* flags: preview | active-team bits */
  u32[12] = flags;
  device.queue.writeBuffer(buf, 0, uniformArrayBuffer);
}

function rectTop() { return { min: [0, topROI.y], max: [TOP_W, topROI.y + topROI.h] }; }
function rectFront() {
  const xs = params.polyF.map(p => p[0]), ys = params.polyF.map(p => p[1]);
  return {
    min: [Math.min(...xs), Math.min(...ys)],
    max: [Math.max(...xs), Math.max(...ys)]
  };
}


(async () => {
  await Feeds.init();

  // WebGPU init
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  const hasF16 = adapter.features.has("shader-f16");
  device = await adapter.requestDevice({
    requiredFeatures: hasF16 ? ["shader-f16"] : []
  });
  console.log("shader-f16:", hasF16);
  ctxTop = $('#topTex').getContext('webgpu');
  ctxTop.configure({ device, format: 'rgba8unorm' });
  ctxFront = $('#frontTex').getContext('webgpu');
  ctxFront.configure({ device, format: 'rgba8unorm' });

  // textures
  const texUsage1 = GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
  const maskUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST;
  frameTex1 = device.createTexture({ size: [TOP_W, TOP_H], format: 'rgba8unorm', usage: texUsage1 });
  maskTex1 = device.createTexture({ size: [TOP_W, TOP_H], format: 'rgba8unorm', usage: maskUsage });
  frameTex2 = device.createTexture({ size: [FRONT_W, FRONT_H], format: 'rgba8unorm', usage: texUsage1 });
  maskTex2 = device.createTexture({ size: [FRONT_W, FRONT_H], format: 'rgba8unorm', usage: maskUsage });
  sampler = device.createSampler();

  // buffers
  uni = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  statsA = device.createBuffer({ size: 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  statsB = device.createBuffer({ size: 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  //statsF = device.createBuffer({ size: 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  readA = device.createBuffer({ size: 12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  readB = device.createBuffer({ size: 12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  //readF = device.createBuffer({ size: 12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  // pipelines
  const code = await fetch('shader.wgsl').then(r => r.text());
  const mod = device.createShaderModule({ code });
  pipeC = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
  pipeQ = device.createRenderPipeline({ layout: 'auto', vertex: { module: mod, entryPoint: 'vs' }, fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' } });

  // bind-groups
  bgR = device.createBindGroup({ layout: pipeQ.getBindGroupLayout(0), entries: [{ binding: 0, resource: frameTex1.createView() }, { binding: 4, resource: maskTex1.createView() }, { binding: 5, resource: sampler }] });
  bgRF = device.createBindGroup({ layout: pipeQ.getBindGroupLayout(0), entries: [{ binding: 0, resource: frameTex2.createView() }, { binding: 4, resource: maskTex2.createView() }, { binding: 5, resource: sampler }] });
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
  // —————————————
  // 2) NEW FRAME LOOP
  // —————————————

  const TOP_FPS = 30;               // throttle only the MJPEG-top feed
  const TOP_INTERVAL = 1000 / TOP_FPS;
  // —————————————
  // 2) TOP-ONLY LOOP  (front runs on demand)
  // —————————————

  let lastTop = 0;
  requestAnimationFrame(topLoop);

  async function topLoop(ts) {
    // throttle only the top feed
    if (ts - lastTop < TOP_INTERVAL) {
      requestAnimationFrame(topLoop);
      return;
    }
    lastTop = ts;

    // 1) Detect on the MJPEG / top camera
    const { detected: topDetected, cntA, cntB } = await runTopDetection();

    // 2) If the blob was big enough, IMMEDIATELY analyse the front feed
    if (topDetected) {
      let flags = params.preview ? FLAG_PREVIEW : 0;
      if (cntA > TOP_MIN_AREA) flags |= FLAG_TEAM_A_ACTIVE;
      if (cntB > TOP_MIN_AREA) flags |= FLAG_TEAM_B_ACTIVE;

      const { detected: frontDetected, hits } = await runFrontDetection(flags);


      if (frontDetected) {
        // emit each hit
        for (const h of hits) {
          doHit(
            h.x * window.innerWidth,
            h.y * window.innerHeight,
            h.team
          );
          console.log('Queued hit:', h);
        }
      }
    }
    // queue next top frame
    requestAnimationFrame(topLoop);
  }
  async function runTopDetection() {

    // 0) clear the statsF buffer to zeros
    //    (so if no new blob is found, cntF will be 0)

    //evice.queue.writeBuffer(statsF, 0, zero);
    device.queue.writeBuffer(statsA, 0, zero);
    device.queue.writeBuffer(statsB, 0, zero);

    /* copy the <img> element directly to GPU texture – no canvas */
    // copy the vertically-centred strip of the <img> directly to the texture
    const srcY = Math.floor((Feeds.top().naturalHeight - TOP_H) / 2);
    device.queue.copyExternalImageToTexture(
      { source: Feeds.top(), origin: { x: 0, y: srcY } },
      { texture: frameTex1 },
      [TOP_W, TOP_H]
    );

    const enc = device.createCommandEncoder();
    enc.beginRenderPass({
      colorAttachments: [{ view: maskTex1.createView(), loadOp: 'clear', storeOp: 'store' }]
    }).end();
    /* always keep both teams active in the TOP pass */
    const flagsTop =
        (params.preview ? FLAG_PREVIEW : 0) |
        FLAG_TEAM_A_ACTIVE | FLAG_TEAM_B_ACTIVE;

    writeUniform(
      uni,
      hsvRange(params.teamA), hsvRange(params.teamB),
      rectTop(),
      flagsTop);
    let cp = enc.beginComputePass();
    cp.setPipeline(pipeC);
    cp.setBindGroup(0, bgTop);
    cp.dispatchWorkgroups(Math.ceil(TOP_W / 8), Math.ceil(TOP_H / 32));
    cp.end();
    enc.copyBufferToBuffer(statsA, 0, readA, 0, 12);
    enc.copyBufferToBuffer(statsB, 0, readB, 0, 12);
    // –– draw the MJPEG feed + mask only in preview mode
    if (params.preview) {
      const rp = enc.beginRenderPass({
        colorAttachments: [{
          view: ctxTop.getCurrentTexture().createView(),
          loadOp: 'clear', storeOp: 'store'
        }]
      });
      rp.setPipeline(pipeQ);
      rp.setBindGroup(0, bgR);
      rp.draw(3);
      rp.end();
    }
    device.queue.submit([enc.finish()]);
    // read back
    await Promise.all([
      readA.mapAsync(GPUMapMode.READ),
      readB.mapAsync(GPUMapMode.READ)
    ]);
    const [cntA] = new Uint32Array(readA.getMappedRange());
    readA.unmap();
    const [cntB] = new Uint32Array(readB.getMappedRange());
    readB.unmap();

    const topDetected = cntA > TOP_MIN_AREA || cntB > TOP_MIN_AREA;
    /* return counts too, so the caller can decide which team(s) to process */
    return { detected: topDetected, cntA, cntB };
  }
  /* ------------------------------------------------------------------
  * FRONT-camera detection
  * ------------------------------------------------------------------ */

  let lastCaptureTime = 0;             // global

  async function runFrontDetection(flags) {
    // 0) use rVFC to avoid re-processing the same video frame
    const meta = await new Promise(res =>
      Feeds.front().requestVideoFrameCallback((_now, m) => res(m))
    );
    if (meta.captureTime === lastCaptureTime) {
      return { detected: false, hits: [] };
    }
    lastCaptureTime = meta.captureTime;

    // 0) clear both team stats
    device.queue.writeBuffer(statsA, 0, zero);
    device.queue.writeBuffer(statsB, 0, zero);

    // copy into texture & dispatch WGSL
    device.queue.copyExternalImageToTexture(
      { source: Feeds.front() },
      { texture: frameTex2 },
      [FRONT_W, FRONT_H]
    );
    const enc2 = device.createCommandEncoder();
    enc2.beginRenderPass({
      colorAttachments: [{ view: maskTex2.createView(), loadOp: 'clear', storeOp: 'store' }]
    }).end();
    writeUniform(
      uni,
      hsvRange(params.teamA), hsvRange(params.teamB),
      rectFront(),
      flags);
    let cp2 = enc2.beginComputePass();
    cp2.setPipeline(pipeC);
    cp2.setBindGroup(0, bgFront);
    cp2.dispatchWorkgroups(Math.ceil(FRONT_W / 8), Math.ceil(FRONT_H / 32));
    cp2.end();
    // copy both team results into their read-back buffers
    enc2.copyBufferToBuffer(statsA, 0, readA, 0, 12);
    enc2.copyBufferToBuffer(statsB, 0, readB, 0, 12);
    // –– draw the device‐cam feed + mask only in preview mode
    if (params.preview) {
      const view2 = ctxFront.getCurrentTexture().createView();
      const rp2 = enc2.beginRenderPass({
        colorAttachments: [{ view: view2, loadOp: 'clear', storeOp: 'store' }]
      });
      rp2.setPipeline(pipeQ);
      rp2.setBindGroup(0, bgRF);
      rp2.draw(3);
      rp2.end();
    }
    device.queue.submit([enc2.finish()]);

    // read back both teams
    await Promise.all([
      readA.mapAsync(GPUMapMode.READ),
      readB.mapAsync(GPUMapMode.READ)
    ]);
    const [cntA, sumXA, sumYA] = new Uint32Array(readA.getMappedRange());
    readA.unmap();
    const [cntB, sumXB, sumYB] = new Uint32Array(readB.getMappedRange());
    readB.unmap();

    // build up zero, one or two hits
    const hits = [];
    if (cntA > FRONT_MIN_AREA) {
      const cx = sumXA / cntA, cy = sumYA / cntA;
      hits.push({ team: params.teamA, x: cx / FRONT_W, y: cy / FRONT_H });
    }
    if (cntB > FRONT_MIN_AREA) {
      const cx = sumXB / cntB, cy = sumYB / cntB;
      hits.push({ team: params.teamB, x: cx / FRONT_W, y: cy / FRONT_H });
    }

    // optionally draw both in preview
    if (params.preview && hits.length) {
      const ctx2d = frontOv.getContext('2d');
      for (const h of hits) {
        ctx2d.fillStyle = h.team;
        const px = h.x * FRONT_W, py = h.y * FRONT_H;
        ctx2d.beginPath();
        ctx2d.arc(px, py, 8, 0, Math.PI * 2);
        ctx2d.fill();
      }
    }
    return { detected: hits.length > 0, hits };

  }
})();
