// rtc-top.js – top camera detection for rtc-connect.html
// Derived from app.js but simplified to only handle the top camera.
(function(){
  'use strict';

  const $ = sel => document.querySelector(sel);

  /* ---- Color tables and helpers copied from app.js ---- */
  const TEAM_INDICES = { red: 0, yellow: 1, blue: 2, green: 3 };
  const COLOR_TABLE = new Float32Array([
    /* red    */ 0.00, 0.5, 0.7, 0.10, 1.00, 1.00,
    /* yellow */ 0.10, 0.5, 0.5, 0.20, 1.00, 1.00,
    /* blue   */ 0.50, 0.4, 0.4, 0.70, 1.00, 1.00,
    /* green  */ 0.70, 0.2, 0.2, 0.90, 1.00, 1.00
  ]);
  const savedCT = localStorage.getItem('COLOR_TABLE');
  if (savedCT) {
    try {
      const arr = JSON.parse(savedCT);
      if (Array.isArray(arr) && arr.length === COLOR_TABLE.length) {
        COLOR_TABLE.set(arr.map(Number));
      }
    } catch(e){}
  }
  const COLOR_EMOJI = { red: '🔴', yellow: '🟡', green: '🟢', blue: '🔵' };
  function hsvRange(team){
    const i = TEAM_INDICES[team] * 6;
    return COLOR_TABLE.subarray(i, i+6);
  }
  function float32ToFloat16(val){
    const f32 = new Float32Array([val]);
    const u32 = new Uint32Array(f32.buffer)[0];
    const sign = (u32 >> 16) & 0x8000;
    let exp = ((u32 >> 23) & 0xFF) - 127 + 15;
    let mant = u32 & 0x7FFFFF;
    if (exp <= 0) return sign;
    if (exp >= 0x1F) return sign | 0x7C00;
    return sign | (exp << 10) | (mant >> 13);
  }
  function hsvRangeF16(team){
    const src = hsvRange(team);
    const dst = new Uint16Array(6);
    for (let i=0;i<6;i++) dst[i] = float32ToFloat16(src[i]);
    return dst;
  }

  // Detection flag bits (subset from app.js)
  const FLAG_TEAM_A_ACTIVE = 2;
  const FLAG_TEAM_B_ACTIVE = 4;

  /* ---- Config copied from app.js (trimmed to top camera only) ---- */
  const Config = (() => {
    const DEFAULTS = {
      topResW: 720,
      topResH: 1280,
      topMinArea: 600,
      teamA: 'green',
      teamB: 'blue',
      polyT: [],
      topRoiW: 720
    };
    const PERSIST = {
      teamA:    'teamA',
      teamB:    'teamB',
      polyT:    'roiPolyTop',
      topRoiW:  'topRoiW',
      topMinArea: 'topMinArea',
      topResW:  'topWidth',
      topResH:  'topHeight'
    };
    let cfg;
    function load(){
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
    function save(name,val){
      if (PERSIST[name]) localStorage.setItem(PERSIST[name], JSON.stringify(val));
      if (cfg) cfg[name] = val;
    }
    function get(){ return cfg; }
    return { load, save, get };
  })();
  Config.load();

  /* ---- Preview graphics for ROI ---- */
  const PreviewGfx = (() => {
    const cfg = Config.get();
    let ctxTop2d;
    function ensure2d(){
      if (!ctxTop2d) ctxTop2d = $('#topOv')?.getContext('2d');
    }
    function drawROI(poly, color){
      ensure2d();
      if (!ctxTop2d) return;
      ctxTop2d.clearRect(0, 0, ctxTop2d.canvas.width, ctxTop2d.canvas.height);
      if (!poly || poly.length !== 4) return;
      ctxTop2d.strokeStyle = color;
      ctxTop2d.lineWidth = 2;
      ctxTop2d.beginPath();
      ctxTop2d.moveTo(poly[0][0], poly[0][1]);
      for (let i=1;i<poly.length;i++) ctxTop2d.lineTo(poly[i][0], poly[i][1]);
      ctxTop2d.closePath();
      ctxTop2d.stroke();
    }
    return { drawROI };
  })();

  /* ---- Setup: ROI gestures and config inputs ---- */
  const Setup = (() => {
    const cfg = Config.get();
    const options = Object.entries(COLOR_EMOJI)
      .map(([c, e]) => `<option value="${c}">${e}</option>`).join('');
    const detectionUI = `
      <label for=topResWInp>W <input id=topResWInp type=number min=1 step=1 style="width:5ch"></label>
      <label for=topResHInp>H <input id=topResHInp type=number min=1 step=1 style="width:5ch"></label>
      <label for=topRoiWInp>↔️ <input id=topRoiWInp type=number min=10 max=${cfg.topResW} step=1></label>
      <label for=topMinInp>⚫ <input id=topMinInp type=number min=0 step=25 style="width:6ch"></label>
      <label for=teamA>🅰️ <select id=teamA>${options}</select></label>
      <label for=teamB>🅱️ <select id=teamB>${options}</select></label>
      <label>HSV <span id=teamAThresh></span></label>`;

    function bind(){
      const cfgEl = $('#cfg');
      cfgEl.insertAdjacentHTML('beforeend', detectionUI);

      const topOv = $('#topOv');
      topOv.width = cfg.topResW;
      topOv.height = cfg.topResH;

      const topROI = { x: 0, w: cfg.topRoiW };
      function commitTop(){
        topROI.x = Math.min(Math.max(0, topROI.x), cfg.topResW - topROI.w);
        const { x, w } = topROI;
        cfg.polyT = [[x, 0], [x + w, 0], [x + w, cfg.topResH], [x, cfg.topResH]];
        Config.save('polyT', cfg.polyT);
        PreviewGfx.drawROI(cfg.polyT, 'lime');
      }
      if (cfg.polyT.length === 4){
        const xs = cfg.polyT.map(p=>p[0]);
        topROI.x = Math.min(...xs);
        topROI.w = Math.max(...xs) - topROI.x;
      }

      const topMinInp = $('#topMinInp');
      const topResWInp = $('#topResWInp');
      const topResHInp = $('#topResHInp');
      const topRoiWInp = $('#topRoiWInp');
      const selA = $('#teamA');
      const selB = $('#teamB');
      const thCont = $('#teamAThresh');

      topMinInp.value = cfg.topMinArea;
      topResWInp.value = cfg.topResW;
      topResHInp.value = cfg.topResH;
      topRoiWInp.value = topROI.w;
      selA.value = cfg.teamA;
      selB.value = cfg.teamB;

      topMinInp.addEventListener('input', e => {
        cfg.topMinArea = Math.max(0, +e.target.value);
        Config.save('topMinArea', cfg.topMinArea);
      });
      topResWInp.addEventListener('input', e => {
        cfg.topResW = Math.max(1, +e.target.value);
        Config.save('topResW', cfg.topResW);
        topRoiWInp.max = cfg.topResW;
      });
      topResHInp.addEventListener('input', e => {
        cfg.topResH = Math.max(1, +e.target.value);
        Config.save('topResH', cfg.topResH);
      });
      topRoiWInp.addEventListener('input', e => {
        topROI.w = Math.max(10, Math.min(cfg.topResW, +e.target.value));
        Config.save('topRoiW', topROI.w);
        commitTop();
      });
      selA.addEventListener('change', e => {
        cfg.teamA = e.target.value;
        Config.save('teamA', cfg.teamA);
        updateThreshInputs();
      });
      selB.addEventListener('change', e => {
        cfg.teamB = e.target.value;
        Config.save('teamB', cfg.teamB);
      });

      const thInputs = [];
      for (let i = 0; i < 6; i++) {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.min = '0';
        inp.max = '1';
        inp.step = '0.05';
        inp.style.width = '4ch';
        thCont.appendChild(inp);
        thInputs.push(inp);
        inp.addEventListener('input', e => {
          const base = TEAM_INDICES[cfg.teamA] * 6 + i;
          COLOR_TABLE[base] = parseFloat(e.target.value);
          localStorage.setItem('COLOR_TABLE',
            JSON.stringify(Array.from(COLOR_TABLE, v => +v.toFixed(2))));
          cfg.f16Ranges[cfg.teamA] = hsvRangeF16(cfg.teamA);
        });
      }
      function updateThreshInputs(){
        const base = TEAM_INDICES[cfg.teamA] * 6;
        for (let i = 0; i < 6; i++) thInputs[i].value = (+COLOR_TABLE[base + i].toFixed(2));
      }
      updateThreshInputs();

      topOv.style.touchAction = 'none';
      let dragX = null;
      topOv.addEventListener('pointerdown', e => {
        const r = topOv.getBoundingClientRect();
        dragX = (e.clientX - r.left) * cfg.topResW / r.width;
        topOv.setPointerCapture(e.pointerId);
      });
      topOv.addEventListener('pointermove', e => {
        if (dragX == null) return;
        const r = topOv.getBoundingClientRect();
        const curX = (e.clientX - r.left) * cfg.topResW / r.width;
        topROI.x += curX - dragX;
        dragX = curX;
        commitTop();
      });
      topOv.addEventListener('pointerup', () => dragX = null);
      topOv.addEventListener('pointercancel', () => dragX = null);
      commitTop();
    }
    return { bind };
  })();

  /* ---- Feeds: top camera via getUserMedia ---- */
  const Feeds = (() => {
    const cfg = Config.get();
    let videoTop;
    async function init(){
      videoTop = $('#topVid');
      // Request camera with LONGER side as width (simple ideal; no extras).
      const longer  = Math.max(cfg.topResW, cfg.topResH);
      const shorter = Math.min(cfg.topResW, cfg.topResH);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: longer }, height: { ideal: shorter }, facingMode: 'user' }
      });
      videoTop.srcObject = stream;
      await videoTop.play();
      // Size the video element via attributes to stored dimensions (CSS controls layout).
      videoTop.width  = cfg.topResW;
      videoTop.height = cfg.topResH;
    }
    return { init, top: ()=>videoTop };
  })();

  /* ---- Detect: WebGPU shader ---- */
  const Detect = (() => {
    const cfg = Config.get();
    let device, frameTex1, maskTex1, sampler, uni, statsA, statsB, readA, readB, pipeC, pipeQ, bgR, bgTop;
    const zero = new Uint32Array([0,0,0]);
    const uniformArrayBuffer = new ArrayBuffer(64);
    const uniformU16 = new Uint16Array(uniformArrayBuffer);
    const uniformF32 = new Float32Array(uniformArrayBuffer);
    const uniformU32 = new Uint32Array(uniformArrayBuffer);
    function writeUniform(buf, hsvA6, hsvB6, rect, flags){
      const u16=uniformU16, f32=uniformF32, u32=uniformU32;
      for(let i=0;i<3;i++) u16[i]=hsvA6[i];
      for(let i=0;i<3;i++) u16[4+i]=hsvA6[i+3];
      for(let i=0;i<3;i++) u16[8+i]=hsvB6[i];
      for(let i=0;i<3;i++) u16[12+i]=hsvB6[i+3];
      f32[8]=rect.min[0]; f32[9]=rect.min[1];
      f32[10]=rect.max[0]; f32[11]=rect.max[1];
      u32[12]=flags;
      device.queue.writeBuffer(buf,0,uniformArrayBuffer);
    }
    function rectTop(){
      const xs = cfg.polyT.map(p=>p[0]);
      return {min:[Math.min(...xs), 0], max:[Math.max(...xs), cfg.topResH]};
    }
    async function init(){
      const adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
      const hasF16 = adapter.features.has('shader-f16');
      device = await adapter.requestDevice({requiredFeatures: hasF16?['shader-f16']:[]});
      const texUsage1 = GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
      const maskUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST;
      frameTex1 = device.createTexture({ size:[cfg.topResW,cfg.topResH], format:'rgba8unorm', usage:texUsage1 });
      maskTex1  = device.createTexture({ size:[cfg.topResW,cfg.topResH], format:'rgba8unorm', usage:maskUsage });
      sampler   = device.createSampler();
      uni   = device.createBuffer({ size:64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      statsA= device.createBuffer({ size:12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      statsB= device.createBuffer({ size:12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      readA = device.createBuffer({ size:12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      readB = device.createBuffer({ size:12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const code = await fetch('shader.wgsl').then(r=>r.text());
      const mod = device.createShaderModule({code});
      pipeC = device.createComputePipeline({ layout:'auto', compute:{ module:mod, entryPoint:'main' } });
      pipeQ = device.createRenderPipeline({ layout:'auto', vertex:{ module:mod, entryPoint:'vs' }, fragment:{ module:mod, entryPoint:'fs', targets:[{format:'rgba8unorm'}]}, primitive:{topology:'triangle-list'} });
      bgR = device.createBindGroup({ layout: pipeQ.getBindGroupLayout(0), entries:[ {binding:0, resource: frameTex1.createView()}, {binding:4, resource: maskTex1.createView()}, {binding:5, resource: sampler} ] });
      bgTop = device.createBindGroup({ layout: pipeC.getBindGroupLayout(0), entries:[ {binding:0, resource: frameTex1.createView()}, {binding:1, resource: maskTex1.createView()}, {binding:2, resource:{buffer:statsA}}, {binding:3, resource:{buffer:statsB}}, {binding:6, resource:{buffer:uni}} ] });
    }
    async function runTopDetection(preview){
      device.queue.writeBuffer(statsA,0,zero);
      device.queue.writeBuffer(statsB,0,zero);
      device.queue.copyExternalImageToTexture(
        {source: Feeds.top()},
        {texture: frameTex1},
        [cfg.topResW,cfg.topResH]
      );
      const enc = device.createCommandEncoder();
      enc.beginRenderPass({ colorAttachments:[{ view: maskTex1.createView(), loadOp:'clear', storeOp:'store' }] }).end();
      const flagsTop = FLAG_TEAM_A_ACTIVE | FLAG_TEAM_B_ACTIVE;
      writeUniform(uni, cfg.f16Ranges[cfg.teamA], cfg.f16Ranges[cfg.teamB], rectTop(), flagsTop);
      let cp = enc.beginComputePass();
      cp.setPipeline(pipeC);
      cp.setBindGroup(0,bgTop);
      cp.dispatchWorkgroups(Math.ceil(cfg.topResW/8), Math.ceil(cfg.topResH/32));
      cp.end();
      enc.copyBufferToBuffer(statsA,0,readA,0,12);
      enc.copyBufferToBuffer(statsB,0,readB,0,12);
      device.queue.submit([enc.finish()]);
      await Promise.all([readA.mapAsync(GPUMapMode.READ), readB.mapAsync(GPUMapMode.READ)]);
      const [cntA] = new Uint32Array(readA.getMappedRange());
      readA.unmap();
      const [cntB] = new Uint32Array(readB.getMappedRange());
      readB.unmap();
      const topDetected = cntA > cfg.topMinArea || cntB > cfg.topMinArea;
      return { detected: topDetected, cntA, cntB };
    }
    return { init, runTopDetection };
  })();

  /* ---- Controller: run detection loop and send bit ---- */
  const Controller = (() => {
    const cfg = Config.get();
    async function topLoop(){
      const { detected, cntA, cntB } = await Detect.runTopDetection(false);
      if (detected) {
        const a = cntA > cfg.topMinArea;
        const b = cntB > cfg.topMinArea;
        let bit;
        if (a && b) bit = 2;
        else if (a) bit = 0;
        else if (b) bit = 1;
        if (bit !== undefined) window.sendBit && window.sendBit(String(bit));
      }
      Feeds.top().requestVideoFrameCallback(topLoop);
    }
    async function start(){
      Setup.bind();
      await Feeds.init();
      await Detect.init();
      Feeds.top().requestVideoFrameCallback(topLoop);
    }
    return { start };
  })();

  window.addEventListener('DOMContentLoaded', () => Controller.start());
})();
