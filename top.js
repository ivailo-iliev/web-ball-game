// rtc-top.js – top camera detection for rtc-connect.html
// Derived from app.js but simplified to only handle the top camera.
(function(){
  'use strict';

  const $ = sel => document.querySelector(sel);

  // --- BLIT SHADER (inline) -----------------------------------------------
  // Samples the HTMLVideoElement as a texture_external and writes into frameTex1.
  // Kept inline so we don't touch shader.wgsl.
  const BLIT_WGSL = /* wgsl */`
  struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>; };
  @vertex
  fn vs_blit(@builtin(vertex_index) i : u32) -> VSOut {
    var p = array<vec2<f32>,3>(
      vec2<f32>(-1.0,-1.0), vec2<f32>( 3.0,-1.0), vec2<f32>(-1.0, 3.0)
    );
    var uv = array<vec2<f32>,3>(
      vec2<f32>(0.0,0.0), vec2<f32>(2.0,0.0), vec2<f32>(0.0,2.0)
    );
    var o: VSOut;
    o.pos = vec4<f32>(p[i], 0.0, 1.0);
    o.uv  = uv[i];
    return o;
  }
  @group(0) @binding(0) var videoExt : texture_external;
  @fragment
  fn fs_blit(in: VSOut) -> @location(0) vec4<f32> {
    // You already flip Y in your main preview shader; match that here
    let uv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
    return textureSampleBaseClampToEdge(videoExt, uv);
  }
  `;
  // ------------------------------------------------------------------------

  // Use the browser-preferred swapchain format for the WebGPU canvas
  const CANVAS_FORMAT = (navigator.gpu && navigator.gpu.getPreferredCanvasFormat)
    ? navigator.gpu.getPreferredCanvasFormat()
    : 'bgra8unorm';

  /* ---- Color tables and helpers copied from app.js ---- */
  const TEAM_INDICES = { red: 0, yellow: 1, blue: 2, green: 3 };
  const COLOR_TABLE = new Float32Array([
    /* red    */ 0.00, 0.5, 0.7, 0.10, 1.00, 1.00,
    /* yellow */ 0.10, 0.5, 0.5, 0.20, 1.00, 1.00,
    /* blue   */ 0.50, 0.4, 0.4, 0.70, 1.00, 1.00,
    /* green  */ 0.70, 0.2, 0.2, 0.90, 1.00, 1.00
  ]);
    const savedCT = localStorage.getItem('TOP_COLOR_TABLE');
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
  const FLAG_PREVIEW = 1;
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
      teamA:    'topTeamA',
      teamB:    'topTeamB',
      polyT:    'topRoiPoly',
      topRoiW:  'topRoiW',
      topMinArea: 'topCamMinArea',
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

  let topVideoW = 0, topVideoH = 0;

  /* ---- Preview graphics for ROI ---- */
  const PreviewGfx = (() => {
    const cfg = Config.get();
    let ctxTop2d, ctxTopGPU;
    let lastW = 0, lastH = 0; // track configured backing size

    function ensure2d(){
      if (!ctxTop2d) ctxTop2d = $('#topOv')?.getContext('2d');
    }

    function ensureGPU(device){
      const c = $('#topTex');
      if (!device || !c || typeof c.getContext !== 'function') return;
      if (!ctxTopGPU) ctxTopGPU = c.getContext('webgpu');
      if (!ctxTopGPU) return;
      // Reconfigure whenever the canvas backing size changes (common in iOS portrait)
      const w = Math.max(1, c.width|0), h = Math.max(1, c.height|0);
      if (w !== lastW || h !== lastH) {
        ctxTopGPU.configure({ device, format: CANVAS_FORMAT, alphaMode: 'premultiplied' });
        lastW = w; lastH = h;
      }
    }

    function forcePresent(device, clearValue = { r:0, g:1, b:0, a:1 }){
      ensureGPU(device);
      if (!ctxTopGPU) return;
      const enc = device.createCommandEncoder();
      const rp = enc.beginRenderPass({
        colorAttachments: [{
          view: ctxTopGPU.getCurrentTexture().createView(),
          loadOp: 'clear',
          clearValue,
          storeOp: 'store'
        }]
      });
      rp.end();
      device.queue.submit([enc.finish()]);
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

    function drawMask(enc, pipe, bg, device){
      ensureGPU(device);
      if (!ctxTopGPU) return;
      const rp = enc.beginRenderPass({
        colorAttachments:[{ view: ctxTopGPU.getCurrentTexture().createView(), loadOp:'clear', storeOp:'store' }]
      });
      rp.setPipeline(pipe);
      rp.setBindGroup(0, bg);
      rp.draw(3);
      rp.end();
    }

    return { drawROI, ensure2d, ensureGPU, drawMask, forcePresent };
  })();

  /* ---- Setup: ROI gestures and config inputs ---- */
  const Setup = (() => {
    const cfg = Config.get();
    const options = Object.entries(COLOR_EMOJI)
      .map(([c, e]) => `<option value="${c}">${e}</option>`).join('');
    const detectionUI = `
      <label for=topResWInp>W <input id=topResWInp type=number min=1 step=1 style="width:5ch"></label>
      <label for=topResHInp>H <input id=topResHInp type=number min=1 step=1 style="width:5ch"></label>
      <label for=topRoiWInp>↔️ <input id=topRoiWInp type=number min=10 step=1></label>
      <label for=topMinInp>⚫ <input id=topMinInp type=number min=0 step=25 style="width:6ch"></label>
      <label for=teamA>🅰️ <select id=teamA>${options}</select></label>
      <label for=teamB>🅱️ <select id=teamB>${options}</select></label>
      <label>HSV <span id=teamAThresh></span></label>`;

    function bind(){
      const cfgEl = $('#cfg');
      cfgEl.insertAdjacentHTML('beforeend', detectionUI);
      cfgEl.insertAdjacentHTML('beforeend', `<div id="vidResDisplay">Video: ${topVideoW}×${topVideoH}</div>`);

      const topOv = $('#topOv');
      topOv.width = topVideoW;
      topOv.height = topVideoH;
      const topTex = $('#topTex');
      if (topTex) {
        topTex.width = topVideoW;
        topTex.height = topVideoH;
      }
      // Force a composition *immediately* after sizing (avoid waiting for RTC/orientation)
      // Use rAF so layout applies before we grab the current texture.
      requestAnimationFrame(() => Detect.presentOnce());

      const topROI = { x: 0, w: Math.min(cfg.topRoiW, topVideoW) };
      function commitTop(){
        topROI.x = Math.min(Math.max(0, topROI.x), topVideoW - topROI.w);
        const { x, w } = topROI;
        cfg.polyT = [[x, 0], [x + w, 0], [x + w, topVideoH], [x, topVideoH]];
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
      topRoiWInp.max = topVideoW;
      topRoiWInp.value = topROI.w;
      selA.value = cfg.teamA;
      selB.value = cfg.teamB;
      if (selA.selectedIndex === -1) {
        selA.selectedIndex = 0;
        cfg.teamA = selA.value;
        Config.save('teamA', cfg.teamA);
      }
      if (selB.selectedIndex === -1) {
        selB.selectedIndex = 0;
        cfg.teamB = selB.value;
        Config.save('teamB', cfg.teamB);
      }

      topMinInp.addEventListener('input', e => {
        cfg.topMinArea = Math.max(0, +e.target.value);
        Config.save('topMinArea', cfg.topMinArea);
      });
      topResWInp.addEventListener('input', e => {
        cfg.topResW = Math.max(1, +e.target.value);
        Config.save('topResW', cfg.topResW);
      });
      topResHInp.addEventListener('input', e => {
        cfg.topResH = Math.max(1, +e.target.value);
        Config.save('topResH', cfg.topResH);
      });
      topRoiWInp.addEventListener('input', e => {
        topROI.w = Math.max(10, Math.min(topVideoW, +e.target.value));
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
            localStorage.setItem('TOP_COLOR_TABLE',
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
        dragX = (e.clientX - r.left) * topVideoW / r.width;
        topOv.setPointerCapture(e.pointerId);
      });
      topOv.addEventListener('pointermove', e => {
        if (dragX == null) return;
        const r = topOv.getBoundingClientRect();
        const curX = (e.clientX - r.left) * topVideoW / r.width;
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
      if (!navigator.mediaDevices?.getUserMedia) {
        console.log('getUserMedia not supported');
        return false;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            width:  { exact: cfg.topResW },
            height: { exact: cfg.topResH },
            facingMode: 'user'
          }
        });
      } catch (err) {
        console.log('Top camera init failed', err);
        return false;
      }
      videoTop.srcObject = stream;
      try {
        await videoTop.play();
        // Wait until the video has non-zero intrinsic dimensions
        await new Promise(resolve => {
          if (videoTop.videoWidth && videoTop.videoHeight) return resolve();
          const onReady = () => {
            if (videoTop.videoWidth && videoTop.videoHeight) {
              videoTop.removeEventListener('loadedmetadata', onReady);
              videoTop.removeEventListener('resize', onReady);
              resolve();
            }
          };
          videoTop.addEventListener('loadedmetadata', onReady);
          videoTop.addEventListener('resize', onReady);
        });
      } catch (err) {
        console.log('Top video play failed', err);
        return false;
      }
      topVideoW = videoTop.videoWidth;
      topVideoH = videoTop.videoHeight;
      videoTop.width  = topVideoW;
      videoTop.height = topVideoH;
      videoTop.style.opacity = '0.1';
      return true;
    }
    return { init, top: ()=>videoTop };
  })();

  /* ---- Detect: WebGPU shader ---- */
  const Detect = (() => {
    const cfg = Config.get();
    let adapter, device, frameTex1, maskTex1, sampler, uni, statsA, statsB, readA, readB, pipeC, pipeQ, bgR, bgTop, blitModule, blitPipe;
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
      return {min:[Math.min(...xs), 0], max:[Math.max(...xs), topVideoH]};
    }
    function presentOnce(){
      if (device) PreviewGfx.forcePresent(device);
    }

    async function init(){
      if (!('gpu' in navigator)) {
        console.log('WebGPU not supported');
        return false;
      }
      try {
        adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
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
        hasF16 = adapter.features?.has && adapter.features.has('shader-f16');
      } catch (err) {
        console.log('f16 check failed', err);
      }
      try {
        device = await adapter.requestDevice({requiredFeatures: hasF16?['shader-f16']:[]});
      } catch (err) {
        console.log('Device request failed', err);
        return false;
      }
      // Create the tiny blit pipeline (external video -> frameTex1)
      try {
        blitModule = device.createShaderModule({ code: BLIT_WGSL });
        blitPipe   = device.createRenderPipeline({
          layout: 'auto',
          vertex:   { module: blitModule, entryPoint: 'vs_blit' },
          fragment: { module: blitModule, entryPoint: 'fs_blit', targets: [{ format: 'rgba8unorm' }] }
        });
      } catch (err) { console.log('Blit pipeline init failed', err); }
      // Use explicit RGBA color format for textures and render targets
      const texUsage1 = GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
      const maskUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST;
      frameTex1 = device.createTexture({
        size: [topVideoW, topVideoH],
        format: 'rgba8unorm', // explicit RGBA format
        usage: texUsage1
      });
      maskTex1  = device.createTexture({ size:[topVideoW,topVideoH], format:'rgba8unorm', usage:maskUsage });
      sampler   = device.createSampler();
      uni   = device.createBuffer({ size:64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      statsA= device.createBuffer({ size:12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      statsB= device.createBuffer({ size:12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      readA = device.createBuffer({ size:12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      readB = device.createBuffer({ size:12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const code = await fetch('shader.wgsl').then(r=>r.text());
      const mod = device.createShaderModule({code});
      pipeC = device.createComputePipeline({ layout:'auto', compute:{ module:mod, entryPoint:'main' } });
      pipeQ = device.createRenderPipeline({ layout:'auto', vertex:{ module:mod, entryPoint:'vs' }, fragment:{ module:mod, entryPoint:'fs', targets:[{ format: CANVAS_FORMAT }] }, primitive:{ topology:'triangle-list' } });
      bgR = device.createBindGroup({ layout: pipeQ.getBindGroupLayout(0), entries:[ {binding:0, resource: frameTex1.createView()}, {binding:4, resource: maskTex1.createView()}, {binding:5, resource: sampler} ] });
      bgTop = device.createBindGroup({ layout: pipeC.getBindGroupLayout(0), entries:[ {binding:0, resource: frameTex1.createView()}, {binding:1, resource: maskTex1.createView()}, {binding:2, resource:{buffer:statsA}}, {binding:3, resource:{buffer:statsB}}, {binding:6, resource:{buffer:uni}} ] });
      return true;
    }
    async function runTopDetection(){
      device.queue.writeBuffer(statsA,0,zero);
      device.queue.writeBuffer(statsB,0,zero);
      const enc = device.createCommandEncoder();
      // GPU blit: HTMLVideoElement -> frameTex1 via texture_external
      try {
        const ext = device.importExternalTexture({ source: Feeds.top() });
        const rpBlit = enc.beginRenderPass({
          colorAttachments: [{
            view: frameTex1.createView(),
            loadOp: 'dontcare',
            storeOp: 'store'
          }]
        });
        const bgBlit = device.createBindGroup({
          layout: blitPipe.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: ext }]
        });
        rpBlit.setPipeline(blitPipe);
        rpBlit.setBindGroup(0, bgBlit);
        rpBlit.draw(3);
        rpBlit.end();
      } catch (err) {
        console.log('Blit pass failed', err);
      }
      enc.beginRenderPass({ colorAttachments:[{ view: maskTex1.createView(), loadOp:'clear', storeOp:'store' }] }).end();
      const flagsTop = FLAG_PREVIEW | FLAG_TEAM_A_ACTIVE | FLAG_TEAM_B_ACTIVE;
      writeUniform(uni, cfg.f16Ranges[cfg.teamA], cfg.f16Ranges[cfg.teamB], rectTop(), flagsTop);
      let cp = enc.beginComputePass();
      cp.setPipeline(pipeC);
      cp.setBindGroup(0,bgTop);
      cp.dispatchWorkgroups(Math.ceil(topVideoW/8), Math.ceil(topVideoH/32));
      cp.end();
      enc.copyBufferToBuffer(statsA,0,readA,0,12);
      enc.copyBufferToBuffer(statsB,0,readB,0,12);
      PreviewGfx.drawMask(enc, pipeQ, bgR, device);
      device.queue.submit([enc.finish()]);
      await Promise.all([readA.mapAsync(GPUMapMode.READ), readB.mapAsync(GPUMapMode.READ)]);
      const [cntA] = new Uint32Array(readA.getMappedRange());
      readA.unmap();
      const [cntB] = new Uint32Array(readB.getMappedRange());
      readB.unmap();
      const topDetected = cntA > cfg.topMinArea || cntB > cfg.topMinArea;
      return { detected: topDetected, cntA, cntB };
    }
    return { init, presentOnce, runTopDetection };
  })();

  /* ---- Controller: run detection loop and send bit ---- */
  const Controller = (() => {
    const cfg = Config.get();
    async function topLoop(){
      try {
        const { detected, cntA, cntB } = await Detect.runTopDetection();
        if (detected) {
          const a = cntA > cfg.topMinArea;
          const b = cntB > cfg.topMinArea;
          let bit;
          if (a && b) bit = 2;
          else if (a) bit = 0;
          else if (b) bit = 1;
          if (bit !== undefined) window.sendBit && window.sendBit(String(bit));
        }
      } catch (e) {
        console.log('topLoop:', e);
      } finally {
        Feeds.top().requestVideoFrameCallback(topLoop);
      }
    }
    async function start(){
      if (!await Feeds.init()) return;
      Setup.bind();
      if (!await Detect.init()) return;
      const t = Feeds.top();
      t && t.requestVideoFrameCallback(topLoop);
    }
    return { start };
  })();

  window.addEventListener('DOMContentLoaded', () => Controller.start());
})();
