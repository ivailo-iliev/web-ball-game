(async function (global) {
  // compute wg for old shader was 8x32; new pass1 uses 16x16, pass2 uses 16x16
  const WG1 = { X: 16, Y: 16 };
  const WG2 = { X: 16, Y: 16 };
  const FLAGS = { PREVIEW: 1, TEAM_A: 2, TEAM_B: 4 };

  function float32ToFloat16(val) {
    const f32 = new Float32Array([val]);
    const u32 = new Uint32Array(f32.buffer)[0];
    const sign = (u32 >> 16) & 0x8000;
    let exp = ((u32 >> 23) & 0xff) - 127 + 15;
    let mant = u32 & 0x7fffff;
    if (exp <= 0) return sign;
    if (exp >= 0x1f) return sign | 0x7c00;
    return sign | (exp << 10) | (mant >> 13);
  }

  async function createPipelines(device, { url = 'shader.wgsl?v3', elementId = null, format = 'rgba8unorm' } = {}) {
    let code;
    if (elementId) {
      const el = document.getElementById(elementId);
      code = el ? el.textContent : '';
    } else {
      code = await fetch(url).then(r => r.text());
    }
    const mod = device.createShaderModule({ code });
    const pass1 = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'pass1' } });
    const pass2 = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'pass2' } });
    const render = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs' },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }
    });
    return { pass1, pass2, render };
  }

  function createUniformPack(device) { // keeps 64B uniform pack shape
    const uni = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // tiny scratch for on-GPU decision
    const bestKey   = device.createBuffer({ size: 4,  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const bestStats = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outRes    = device.createBuffer({ size: 24, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const outRead   = device.createBuffer({ size: 24, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const zero4     = new Uint32Array(1);
    const zeroStats = new Uint32Array(4);
    const buffer = new ArrayBuffer(64);
    const u16 = new Uint16Array(buffer);
    const f32 = new Float32Array(buffer);
    const u32 = new Uint32Array(buffer);

    function writeUniform(queue, hsvA6, hsvB6, rect, flags) {
      u16.set(hsvA6.subarray(0, 3), 0);
      u16.set(hsvA6.subarray(3, 6), 4);
      u16.set(hsvB6.subarray(0, 3), 8);
      u16.set(hsvB6.subarray(3, 6), 12);
      f32.set(rect.min, 8);
      f32.set(rect.max, 10);
      u32[12] = flags;
      queue.writeBuffer(uni, 0, buffer);
    }

    function resetScratch(queue) {
      queue.writeBuffer(bestKey,   0, zero4);
      queue.writeBuffer(bestStats, 0, zeroStats);
    }

    async function readResult() {
      await outRead.mapAsync(GPUMapMode.READ);
      const r = new DataView(outRead.getMappedRange());
      const cx = r.getFloat32(0, true);
      const cy = r.getFloat32(4, true);
      const rad = r.getFloat32(8, true);
      const iq = r.getFloat32(12, true);
      const mass = r.getUint32(16, true);
      const ok = r.getUint32(20, true);
      outRead.unmap();
      return { cx, cy, r: rad, iq, mass, ok };
    }

    return { uni, bestKey, bestStats, outRes, outRead, writeUniform, resetScratch, readResult };
  }

  function createFeed(device, pipelines, sampler, w, h) {
    // Use an explicit RGBA format for textures that may be bound as storage.
    // "bgra8unorm" (the common canvas format) is not allowed with
    // GPUTextureUsage.STORAGE_BINDING, which caused validation failures in
    // Chrome when creating the mask texture.
    const texFormat = 'rgba8unorm';

    const frameTex = device.createTexture({
      size: { width: w, height: h },
      format: texFormat,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    const maskTex = device.createTexture({
      size: { width: w, height: h },
      format: texFormat,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST
    });
    const frameView = frameTex.createView();
    const maskView = maskTex.createView();
    let bgCompute1 = null, bgCompute2 = null; // compute bind groups
    const renderBG = device.createBindGroup({
      layout: pipelines.render.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: frameView },
        { binding: 4, resource: maskView },
        { binding: 5, resource: sampler }
      ]
    });
function computeBG(pack) {
  if (!bgCompute1 || !bgCompute2) {
    // PASS 1 — expects 5 bindings: 0,1,2,3,6
    bgCompute1 = device.createBindGroup({
      layout: pipelines.pass1.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: frameView },
        { binding: 1, resource: maskView },                 // storageTexture (write)
        { binding: 2, resource: { buffer: pack.bestKey } }, // 4 B atomic<u32>
        { binding: 3, resource: { buffer: pack.bestStats } },// 16 B
        { binding: 6, resource: { buffer: pack.uni } }       // ≥56 B (you have 64 B)
      ]
    });

    // PASS 2 — expects 4 bindings: 0,3,4,6 (NO b1, NO b2)
    bgCompute2 = device.createBindGroup({
      layout: pipelines.pass2.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: frameView },
        { binding: 3, resource: { buffer: pack.bestStats } },
        { binding: 4, resource: { buffer: pack.outRes } },   // 24 B
        { binding: 6, resource: { buffer: pack.uni } }
      ]
    });
  }
  return { pass1: bgCompute1, pass2: bgCompute2 };
}

    function destroy() {
      frameTex.destroy();
      maskTex.destroy();
    }
    return { w, h, frameTex, maskTex, frameView, maskView, computeBG, renderBG, destroy };
  }

  function hsvRangeF16(teamIndices, colorTable, team) {
    const i = teamIndices[team] * 6;
    const dst = new Uint16Array(6);
    for (let j = 0; j < 6; j++) dst[j] = float32ToFloat16(colorTable[i + j]);
    return dst;
  }

  const _devState = new WeakMap();
  let _device = null;
  let _format = null;

  async function _ensureDevice() {
    if (_device) return _device;
    if (!('gpu' in navigator)) throw new Error('WebGPU not supported');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    if (!adapter.features?.has?.('shader-f16')) throw new Error('shader-f16 not supported');
    _device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] });
    _format = navigator.gpu.getPreferredCanvasFormat?.() || 'rgba8unorm';
    return _device;
  }

  function _sizeOf(src) {
    const w = src?.codedWidth ?? src?.videoWidth ?? src?.naturalWidth ?? src?.width;
    const h = src?.codedHeight ?? src?.videoHeight ?? src?.naturalHeight ?? src?.height;
    return { w, h };
  }

  async function detect({
    key = 'default',
    source,
    hsvA6,
    hsvB6,
    rect = null,
    previewCanvas = null,
    preview = false,
    activeA = true,
    activeB = true,
    flipY = true
  } = {}) {
    const device = await _ensureDevice();
    if (!source) throw new Error('detect: source required');

    let state = _devState.get(device);
    if (!state) {
      state = { pipelines: null, sampler: null, ctxByKey: new Map() };
      _devState.set(device, state);
    }
    if (!state.pipelines) state.pipelines = await createPipelines(device, { format: _format });
    if (!state.sampler)   state.sampler   = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

    let ctx = state.ctxByKey.get(key);
    if (!ctx) {
      const pack = createUniformPack(device);
      pack.hA = new Uint16Array(6);
      pack.hB = new Uint16Array(6);
      ctx = {
        pack,
        feed: null,
        defaultRect: { min: new Float32Array([0,0]), max: new Float32Array([0,0]) },
        rectGpu: { min: new Float32Array(2), max: new Float32Array(2) },
        canvasCtx: null
      };
      state.ctxByKey.set(key, ctx);
    }
    while (ctx.running) await ctx.running;
    ctx.running = (async () => {
      const { w, h } = _sizeOf(source);
      if (!(w > 0 && h > 0)) throw new Error('detect: bad source size');
      let resized = false;
      if (!ctx.feed || ctx.feed.w !== w || ctx.feed.h !== h) {
        ctx.feed?.destroy?.();
        // Internal textures use RGBA format to support storage binding;
        // the canvas may still prefer a BGRA format for presentation.
        ctx.feed = createFeed(device, state.pipelines, state.sampler, w, h);
        ctx.defaultRect.max[0] = w;
        ctx.defaultRect.max[1] = h;
        resized = true;
      }

      let view = null;
      if (preview && previewCanvas) {
        if (!ctx.canvasCtx) {
          ctx.canvasCtx = previewCanvas.getContext('webgpu');
          previewCanvas.width = w;
          previewCanvas.height = h;
          ctx.canvasCtx.configure({ device, format: _format, alphaMode: 'opaque' });
        } else if (resized) {
          previewCanvas.width = w;
          previewCanvas.height = h;
          ctx.canvasCtx.configure({ device, format: _format, alphaMode: 'opaque' });
        }
        view = ctx.canvasCtx.getCurrentTexture().createView();
      }

      const FLAGS_PREVIEW = 1, FLAGS_A = 2, FLAGS_B = 4;
      const flags = (preview ? FLAGS_PREVIEW : 0) | (activeA ? FLAGS_A : 0) | (activeB ? FLAGS_B : 0);

      if (!(hsvA6 instanceof Uint16Array) || !(hsvB6 instanceof Uint16Array)) {
        throw new Error('detect: hsvA6/hsvB6 must be Uint16Array');
      }
      ctx.pack.hA.set(hsvA6);
      ctx.pack.hB.set(hsvB6);
      ctx.pack.resetScratch(device.queue);
      let r = rect || ctx.defaultRect;
      if (flipY) {
        const rg = ctx.rectGpu;
        rg.min[0] = r.min[0];
        rg.max[0] = r.max[0];
        rg.min[1] = h - r.max[1];
        rg.max[1] = h - r.min[1];
        r = rg;
      }
      ctx.pack.writeUniform(device.queue, ctx.pack.hA, ctx.pack.hB, r, flags);

      device.queue.copyExternalImageToTexture(
        { source, origin: { x: 0, y: 0 }, flipY },
        { texture: ctx.feed.frameTex },
        { width: w, height: h }
      );

      const enc = device.createCommandEncoder();
      enc.beginRenderPass({ colorAttachments: [{ view: ctx.feed.maskView, loadOp: 'clear', storeOp: 'store' }] }).end();
      const c = enc.beginComputePass({ label: 'detect' });
      const bgs = ctx.feed.computeBG(ctx.pack);
      // pass 1: full ROI tiles
      c.setPipeline(state.pipelines.pass1);
      c.setBindGroup(0, bgs.pass1);
      c.dispatchWorkgroups(Math.ceil(w / WG1.X), Math.ceil(h / WG1.Y));
      // pass 2: single WG region grow around winner
      c.setPipeline(state.pipelines.pass2);
      c.setBindGroup(0, bgs.pass2);
      c.dispatchWorkgroups(1, 1, 1);
      c.end();
      enc.copyBufferToBuffer(ctx.pack.outRes, 0, ctx.pack.outRead, 0, 24);

      if (view) {
        const r = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
        r.setPipeline(state.pipelines.render);
        r.setBindGroup(0, ctx.feed.renderBG);
        r.draw(3);
        r.end();
      }

      device.queue.submit([enc.finish()]);
      const res = await ctx.pack.readResult();

      return { result: res, w, h, resized };
    })();
    try {
      return await ctx.running;
    } finally {
      ctx.running = null;
    }
  }

  // Expose helpers and flag constants for external modules like top.js.
  global.GPUShared = { detect, hsvRangeF16, FLAGS };
})(window);
