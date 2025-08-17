(function (global) {
  const WG_SIZE = { X: 8, Y: 32 };
  const FLAGS = { PREVIEW: 1, TEAM_A: 2, TEAM_B: 4 };

  // --- internal device/context cache (hidden) ---
  const _DEV = new WeakMap(); // GPUDevice -> { format, pipelines, sampler, ctxs: Map(key -> Ctx) }
  async function _getState(device, format) {
    let st = _DEV.get(device);
    if (!st) { st = { format, pipelines: null, sampler: null, ctxs: new Map() }; _DEV.set(device, st); }
    if (!st.pipelines) st.pipelines = await createPipelines(device, { format });
    if (!st.sampler)   st.sampler   = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
    return st;
  }
  function _sizeOf(source) {
    const w = source?.codedWidth ?? source?.videoWidth ?? source?.naturalWidth ?? source?.width;
    const h = source?.codedHeight ?? source?.videoHeight ?? source?.naturalHeight ?? source?.height;
    return { w, h };
  }

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

  function createFeed(device, pipelines, sampler, w, h, format = 'rgba8unorm') {
    const frameTex = device.createTexture({
      size: { width: w, height: h },
      format,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    const maskTex = device.createTexture({
      size: { width: w, height: h },
      format,
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

  // --- single public method ---
  async function detect(device, {
    key       = 'default',
    source,                   // VideoFrame | HTMLVideoElement | HTMLImageElement | ImageBitmap
    rect      = null,         // {min:[x,y], max:[x,y]} in pixels; defaults to full frame
    hsvA6, hsvB6,             // Uint16Array(6) half-floats (you already precompute these)
    flags     = 0,            // GPUShared.FLAGS.*
    view      = null,         // optional: GPUTextureView for preview overlay
    flipY     = true,
    format    = 'rgba8unorm'  // canvas/texture format
  } = {}) {
    if (!navigator.gpu) throw new Error('WebGPU not supported');
    if (!device?.features?.has?.('shader-f16')) throw new Error('shader-f16 not supported');
    if (!source) throw new Error('detect: source required');

    // state for this device
    const st = await _getState(device, format);

    // per-key context (separate pack/feed so top/front can run independently)
    let ctx = st.ctxs.get(key);
    if (!ctx) {
      const pack = createUniformPack(device);
      pack.hsvA6 = new Uint16Array(6);
      pack.hsvB6 = new Uint16Array(6);
      ctx = { pack, feed: null, rectDefault: { min: new Float32Array(2), max: new Float32Array(2) } };
      st.ctxs.set(key, ctx);
    }

    // ensure feed size
    const { w, h } = _sizeOf(source);
    if (!(w > 0 && h > 0)) throw new Error('detect: could not determine source size');
    let resized = false;
    if (!ctx.feed || ctx.feed.w !== w || ctx.feed.h !== h) {
      ctx.feed?.destroy?.();
      ctx.feed = createFeed(device, st.pipelines, st.sampler, w, h, st.format);
      ctx.rectDefault.max[0] = w;
      ctx.rectDefault.max[1] = h;
      resized = true;
    }

    // uniforms
    if (hsvA6) ctx.pack.hsvA6.set(hsvA6);
    if (hsvB6) ctx.pack.hsvB6.set(hsvB6);
    const useRect = rect || ctx.rectDefault;
    ctx.pack.resetStats(device.queue);
    ctx.pack.writeUniform(device.queue, ctx.pack.hsvA6, ctx.pack.hsvB6, useRect, flags);

    // upload frame
    device.queue.copyExternalImageToTexture(
      { source, origin: { x: 0, y: 0 }, flipY },
      { texture: ctx.feed.frameTex },
      { width: w, height: h }
    );

    // compute + (optional) present
    const enc = device.createCommandEncoder();
    enc.beginRenderPass({ colorAttachments: [{ view: ctx.feed.maskView, loadOp: 'clear', storeOp: 'store' }] }).end();
    const pass = enc.beginComputePass({ label: 'detect-compute' });
    pass.setPipeline(st.pipelines.compute);
    pass.setBindGroup(0, ctx.feed.computeBG(ctx.pack));
    pass.dispatchWorkgroups(Math.ceil(w / WG_SIZE.X), Math.ceil(h / WG_SIZE.Y));
    pass.end();
    enc.copyBufferToBuffer(ctx.pack.statsA, 0, ctx.pack.readA, 0, 12);
    enc.copyBufferToBuffer(ctx.pack.statsB, 0, ctx.pack.readB, 0, 12);
    if (view) {
      const r = enc.beginRenderPass({ label: 'mask-present', colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
      r.setPipeline(st.pipelines.render);
      r.setBindGroup(0, ctx.feed.renderBG);
      r.draw(3);
      r.end();
    }
    device.queue.submit([enc.finish()]);

    const { a, b } = await ctx.pack.readStats();
    return { a, b, resized, w, h };
  }

  // Only expose what callers need.
  const GPUShared = { FLAGS, hsvRangeF16, detect };

  global.GPUShared = GPUShared;
})(window);
