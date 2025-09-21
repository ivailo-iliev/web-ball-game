(async function (global) {
  const FLAGS = { PREVIEW: 1, TEAM_A: 2, TEAM_B: 4 };
  let _shaderUrl = 'app/shader.wgsl';

  async function createPipelines(device, { url = _shaderUrl, elementId = null, format = 'rgba8unorm' } = {}) {
    let code;
    if (elementId != null) {
      const el = $(`#${elementId}`);
      if (!el || !el.textContent) throw new Error(`WGSL element #${elementId} missing/empty`);
      code = el.textContent;
    } else {
      code = await fetch(url).then(r => r.text());
    }
    const mod = device.createShaderModule({ code });
    // New entry points in WGSL: 'seed_grid' (sparse grid) and 'refine_micro' (tiny refine)
    const computeSeed = device.createComputePipeline({
      layout: 'auto',
      compute: { module: mod, entryPoint: 'seed_grid' }
    });
    const computeRefine = device.createComputePipeline({
      layout: 'auto',
      compute: { module: mod, entryPoint: 'refine_micro' }
    });
    // Preview is optional; your WGSL may not include vs/fs
    let render = null;
    try {
      render = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: mod, entryPoint: 'vs' },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' }
      });
    } catch (_) { /* no preview shaders present; fine */ }
    return { computeSeed, computeRefine, render };
  }

  function createUniformPack(device) {
    // 64-byte uniform; see offsets in writeUniform below
    const uni    = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // Final refined sums (cnt,sumX,sumY)
    const statsA = device.createBuffer({ size: 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const statsB = device.createBuffer({ size: 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    // Seeds (BestA/BestB): (key,x,y)
    const bestA  = device.createBuffer({ size: 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const bestB  = device.createBuffer({ size: 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    // Grid completion counter for in-pass finalize (binding @8)
    const grid   = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const readA = device.createBuffer({ size: 12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); // will read BestA
    const readB = device.createBuffer({ size: 12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); // will read BestB
    const zero3  = new Uint32Array(3);
    const zero12 = new Uint32Array(3); // for BestA/BestB too
    const zero1  = new Uint32Array(1); // for Grid.done
    const buffer = new ArrayBuffer(64);
    const f32 = new Float32Array(buffer);
    const u32 = new Uint32Array(buffer);

    // Uniform layout (64B):
    //  0: u32 rMin.x,  4: u32 rMin.y
    //  8: u32 rMax.x, 12: u32 rMax.y
    // 16: f32 radiusPx
    // 20: u32 colorA, 24: u32 colorB
    // 28: f32 domThrA, 32: f32 satMinA, 36: f32 yMinA, 40: f32 yMaxA
    // 44: f32 domThrB, 48: f32 satMinB, 52: f32 yMinB, 56: f32 yMaxB
    // 60: u32 activeMask (bit0=A, bit1=B)
    function writeUniform(queue, rect, radiusPx, colorA, colorB,
                          domThrA, satMinA, yMinA, yMaxA,
                          domThrB, satMinB, yMinB, yMaxB,
                          activeMask) {
      u32[0] = rect.min[0] >>> 0;
      u32[1] = rect.min[1] >>> 0;
      u32[2] = rect.max[0] >>> 0;
      u32[3] = rect.max[1] >>> 0;
      f32[4] = radiusPx;
      u32[5] = (colorA >>> 0);
      u32[6] = (colorB >>> 0);
      f32[7]  = domThrA;
      f32[8]  = satMinA;
      f32[9]  = yMinA;
      f32[10] = yMaxA;
      f32[11] = domThrB;
      f32[12] = satMinB;
      f32[13] = yMinB;
      f32[14] = yMaxB;
      u32[15] = (activeMask >>> 0);
      queue.writeBuffer(uni, 0, buffer);
    }

    function resetStats(queue) {
      queue.writeBuffer(statsA, 0, zero3);
      queue.writeBuffer(statsB, 0, zero3);
      queue.writeBuffer(bestA,  0, zero12);
      queue.writeBuffer(bestB,  0, zero12);
      queue.writeBuffer(grid,   0, zero1);
    }

    async function readBest() {
      await Promise.all([
        readA.mapAsync(GPUMapMode.READ),
        readB.mapAsync(GPUMapMode.READ)
      ]);
      const a = new Uint32Array(readA.getMappedRange()).slice(0, 3); // [key, x, y]
      const b = new Uint32Array(readB.getMappedRange()).slice(0, 3); // [key, x, y]
      readA.unmap();
      readB.unmap();
      return { a, b };
    }

    return { uni, statsA, statsB, bestA, bestB, grid, readA, readB, writeUniform, resetStats, readBest };
  }

  function createFeed(device, pipelines, sampler, w, h) {
    // Use explicit formats. Frame is SRGB so sampling auto-decodes to linear.
    // "bgra8unorm" (the common canvas format) is not allowed with
    // GPUTextureUsage.STORAGE_BINDING, which caused validation failures in
    // Chrome when creating the mask texture.
    const frameFormat = 'rgba8unorm-srgb';
    const maskFormat  = 'rgba8unorm';

    const frameTex = device.createTexture({
      size: { width: w, height: h },
      format: frameFormat,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    const maskTex = device.createTexture({
      size: [w, h],
      format: maskFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
    });
    const frameView = frameTex.createView();
    const maskView = maskTex.createView();
    // Render bind group (fragment samples frame@1, maskTex@4 with sampler@5)
    let renderBG = null;
    function getRenderBG(pack) {
      if (!pipelines.render) return null;
      if (!renderBG) {
        renderBG = device.createBindGroup({
          layout: pipelines.render.getBindGroupLayout(0),
          entries: [
            { binding: 1, resource: frameView },               // texture_2d<f32> frame
            { binding: 2, resource: { buffer: pack.bestA } },  // storage BestA
            { binding: 3, resource: { buffer: pack.bestB } },  // storage BestB
            { binding: 4, resource: maskView },                // texture_2d<f32> maskTex
            { binding: 5, resource: sampler },                 // sampler samp2
            { binding: 6, resource: { buffer: pack.uni } }     // uniform U
          ]
        });
      }
      return renderBG;
    }

    // Separate compute bind groups per pipeline entry (auto-layout depends on used bindings)
    let bgSeed   = null;
    let bgRefine = null;

    function computeBGSeed(pack) {
      if (!bgSeed) {
        bgSeed = device.createBindGroup({
          layout: pipelines.computeSeed.getBindGroupLayout(0),
          entries: [
            // seed_grid uses: frame@1, BestA@2, BestB@3, U@6, maskOut@7
            { binding: 1, resource: frameView },
            { binding: 2, resource: { buffer: pack.bestA } },
            { binding: 3, resource: { buffer: pack.bestB } },
            { binding: 6, resource: { buffer: pack.uni } },
            { binding: 7, resource: maskView }
          ]
        });
      }
      return bgSeed;
    }

    function computeBGRefine(pack) {
      if (!bgRefine) {
        bgRefine = device.createBindGroup({
          layout: pipelines.computeRefine.getBindGroupLayout(0),
          entries: [
            // refine_micro uses: frame@1, BestA@2, BestB@3, StatsA@4, StatsB@5, U@6, maskOut@7, Grid@8
            { binding: 1, resource: frameView },
            { binding: 2, resource: { buffer: pack.bestA } },
            { binding: 3, resource: { buffer: pack.bestB } },
            { binding: 4, resource: { buffer: pack.statsA } },
            { binding: 5, resource: { buffer: pack.statsB } },
            { binding: 6, resource: { buffer: pack.uni } },
            { binding: 7, resource: maskView },
            { binding: 8, resource: { buffer: pack.grid } }
          ]
        });
      }
      return bgRefine;
    }

    function destroy() {
      frameTex.destroy();
      maskTex.destroy();
    }
    return { w, h, frameTex, maskTex, frameView, maskView, computeBGSeed, computeBGRefine, getRenderBG, destroy };
  }

  const _devState = new WeakMap();
  let _device = null;
  let _format = null;

  async function _ensureDevice() {
    if (_device) return _device;
    if (!('gpu' in navigator)) throw new Error('WebGPU not supported');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    const hasF16 = adapter.features?.has?.('shader-f16');
    const desc = hasF16 ? { requiredFeatures: ['shader-f16'] } : {};
    _device = await adapter.requestDevice(desc);
    _format = navigator.gpu.getPreferredCanvasFormat();
    _shaderUrl = hasF16 ? 'app/shader.wgsl' : 'app/shader_f32.wgsl';
    return _device;
  }

  function _sizeOf(src) {
    // Be explicit: VideoFrame vs HTMLImageElement
    if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) {
      return { w: src.displayWidth, h: src.displayHeight };
    }
    if (src && typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) {
      return { w: src.naturalWidth, h: src.naturalHeight };
    }
    throw new Error('detect: unsupported source type for size');
  }

  async function detect({
    key,
    source,
    rect,
    previewCanvas,
    preview,
    activeA,
    activeB,
    flipY,
    // Calibration knobs for the new WGSL (all required; callers must pass explicit values)
    colorA,
    colorB,
    domThrA, satMinA, yMinA, yMaxA,
    domThrB, satMinB, yMinB, yMaxB,
    radiusPx,
    refine
  }) {
    const device = await _ensureDevice();
    if (!source) throw new Error('detect: source required');
    if (typeof refine !== 'boolean') throw new Error('detect: refine flag required');

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
      ctx = { pack, feed: null, canvasCtx: null };
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
      resized = true;
    }

    let view = null;
    if (preview && previewCanvas) {
      if (!ctx.canvasCtx || resized) {
        ctx.canvasCtx = previewCanvas.getContext('webgpu');
        previewCanvas.width = w;
        previewCanvas.height = h;
        ctx.canvasCtx.configure({ device, format: _format, alphaMode: 'opaque' });
      }
      view = ctx.canvasCtx.getCurrentTexture().createView();
    }

    // activeMask for the new WGSL: bit0(A), bit1(B)
    const activeMask = (activeA ? 1 : 0) | (activeB ? 2 : 0);
    ctx.pack.resetStats(device.queue);
    // Sole fallback allowed: full-frame when rect is null/undefined
    const roi = (rect && rect.min && rect.max)
      ? rect
      : { min: new Float32Array([0, 0]), max: new Float32Array([w, h]) };
    ctx.pack.writeUniform(
      device.queue,
      roi,
      radiusPx,
      colorA, colorB,
      domThrA, satMinA, yMinA, yMaxA,
      domThrB, satMinB, yMinB, yMaxB,
      activeMask
    );

    device.queue.copyExternalImageToTexture(
      { source, origin: { x: 0, y: 0 }, flipY },
      { texture: ctx.feed.frameTex },
      { width: w, height: h }
    );

    const enc = device.createCommandEncoder();
    // (Optional) clear preview target if you use it
    if (preview) {
      enc.beginRenderPass({ colorAttachments: [{ view: ctx.feed.maskView, loadOp: 'clear', storeOp: 'store' }] }).end();
    }

    // Pass 1: sparse grid seed
    const seedPass = enc.beginComputePass({ label: 'detect:seed_grid' });
    seedPass.setPipeline(state.pipelines.computeSeed);
    seedPass.setBindGroup(0, ctx.feed.computeBGSeed(ctx.pack));
    // Dispatch over the GRID, not full image:
    const roiW = roi.max[0] - roi.min[0];
    const roiH = roi.max[1] - roi.min[1];
    const gridStride = Math.max(1, Math.round((radiusPx * 2) / 3));
    const gridW = Math.ceil(roiW / gridStride);
    const gridH = Math.ceil(roiH / gridStride);
    seedPass.dispatchWorkgroups(gridW, gridH);
    seedPass.end();

    // Pass 2: tiny refine around seeds (tile grid)
    if (refine) {
      const refinePass = enc.beginComputePass({ label: 'detect:refine_micro' });
      refinePass.setPipeline(state.pipelines.computeRefine);
      refinePass.setBindGroup(0, ctx.feed.computeBGRefine(ctx.pack));
      refinePass.dispatchWorkgroups(Math.ceil(roiW / 8), Math.ceil(roiH / 8));
      refinePass.end();
    }

    // Read back winning seeds (BestA/BestB: key,x,y) — centroid finalized on GPU
    enc.copyBufferToBuffer(ctx.pack.bestA, 0, ctx.pack.readA, 0, 12);
    enc.copyBufferToBuffer(ctx.pack.bestB, 0, ctx.pack.readB, 0, 12);

    if (preview && view && state.pipelines.render) {
      const r = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
      r.setPipeline(state.pipelines.render);
      r.setBindGroup(0, ctx.feed.getRenderBG(ctx.pack));
      r.draw(3);
      r.end();
    }

    device.queue.submit([enc.finish()]);
    const { a, b } = await ctx.pack.readBest();
    // a/b are [key, x, y]; key packs score in high bits if you need it
    return { a, b, w, h, resized };
  }

  global.GPU = { detect };
})(window);
