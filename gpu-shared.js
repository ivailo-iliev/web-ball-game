(async function (global) {
  const WG_SIZE = { X: 8, Y: 32 };
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

  async function createPipelines(device, { url = 'shader.wgsl', elementId = null, format = 'rgba8unorm' } = {}) {
    let code;
    if (elementId) {
      const el = document.getElementById(elementId);
      code = el ? el.textContent : '';
    } else {
      code = await fetch(url).then(r => r.text());
    }
    const mod = device.createShaderModule({ code });
    const compute = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
    const render = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs' },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }
    });
    return { compute, render };
  }

  function createUniformPack(device) {
    const uni = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const statsA = device.createBuffer({ size: 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const statsB = device.createBuffer({ size: 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const readA = device.createBuffer({ size: 12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const readB = device.createBuffer({ size: 12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const zero = new Uint32Array(3);
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

    function resetStats(queue) {
      queue.writeBuffer(statsA, 0, zero);
      queue.writeBuffer(statsB, 0, zero);
    }

    async function readStats() {
      await Promise.all([
        readA.mapAsync(GPUMapMode.READ),
        readB.mapAsync(GPUMapMode.READ)
      ]);
      const a = new Uint32Array(readA.getMappedRange()).slice(0, 3);
      const b = new Uint32Array(readB.getMappedRange()).slice(0, 3);
      readA.unmap();
      readB.unmap();
      return { a, b };
    }

    return { uni, statsA, statsB, readA, readB, writeUniform, resetStats, readStats };
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
    let bgCompute = null;
    const renderBG = device.createBindGroup({
      layout: pipelines.render.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: frameView },
        { binding: 4, resource: maskView },
        { binding: 5, resource: sampler }
      ]
    });
    function computeBG(pack) {
      if (!bgCompute) {
        bgCompute = device.createBindGroup({
          layout: pipelines.compute.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: frameView },
            { binding: 1, resource: maskView },
            { binding: 2, resource: { buffer: pack.statsA } },
            { binding: 3, resource: { buffer: pack.statsB } },
            { binding: 6, resource: { buffer: pack.uni } }
          ]
        });
      }
      return bgCompute;
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
      ctx = { pack, feed: null, defaultRect: { min: new Float32Array([0,0]), max: new Float32Array([0,0]) }, canvasCtx: null };
      state.ctxByKey.set(key, ctx);
    }

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
        const gc = previewCanvas.getContext('webgpu');
        gc.configure({ device, format: _format, alphaMode: 'opaque' });
        ctx.canvasCtx = gc;
      }
      view = ctx.canvasCtx.getCurrentTexture().createView();
      if (resized) { previewCanvas.width = w; previewCanvas.height = h; }
    }

    const FLAGS_PREVIEW = 1, FLAGS_A = 2, FLAGS_B = 4;
    const flags = (preview ? FLAGS_PREVIEW : 0) | (activeA ? FLAGS_A : 0) | (activeB ? FLAGS_B : 0);

    for (let i = 0; i < 6; i++) {
      ctx.pack.hA[i] = float32ToFloat16(hsvA6[i]);
      ctx.pack.hB[i] = float32ToFloat16(hsvB6[i]);
    }
    ctx.pack.resetStats(device.queue);
    ctx.pack.writeUniform(device.queue, ctx.pack.hA, ctx.pack.hB, rect || ctx.defaultRect, flags);

    device.queue.copyExternalImageToTexture(
      { source, origin: { x: 0, y: 0 }, flipY },
      { texture: ctx.feed.frameTex },
      { width: w, height: h }
    );

    const enc = device.createCommandEncoder();
    enc.beginRenderPass({ colorAttachments: [{ view: ctx.feed.maskView, loadOp: 'clear', storeOp: 'store' }] }).end();
    const c = enc.beginComputePass({ label: 'detect' });
    c.setPipeline(state.pipelines.compute);
    c.setBindGroup(0, ctx.feed.computeBG(ctx.pack));
    c.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 32));
    c.end();
    enc.copyBufferToBuffer(ctx.pack.statsA, 0, ctx.pack.readA, 0, 12);
    enc.copyBufferToBuffer(ctx.pack.statsB, 0, ctx.pack.readB, 0, 12);

    if (view) {
      const r = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
      r.setPipeline(state.pipelines.render);
      r.setBindGroup(0, ctx.feed.renderBG);
      r.draw(3);
      r.end();
    }

    device.queue.submit([enc.finish()]);
    const { a, b } = await ctx.pack.readStats();

    return { a, b, w, h, resized };
  }

  // Expose helpers and flag constants for external modules like top.js.
  global.GPUShared = { detect, hsvRangeF16, FLAGS };
})(window);
