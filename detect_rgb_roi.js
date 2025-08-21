(async function (global) {
  const WG_SIZE = { X: 16, Y: 16 };
  const FLAGS = { PREVIEW: 1, TEAM_A: 2, TEAM_B: 4 };

  async function createPipelines(device, { url = 'shader_rgb_roi.wgsl', elementId = null, format = 'rgba8unorm' } = {}) {
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

  function createUniformPack(device) {
    const bestKey = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const bestStats = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outRes = device.createBuffer({ size: 24, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const outRead = device.createBuffer({ size: 24, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const uni = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    function reset(queue) {
      queue.writeBuffer(bestKey, 0, new Uint32Array([0]));
    }

    function writeUniform(queue, thrA, thrB, rect, flags, radiusPx) {
      const f32 = new Float32Array(16);
      let o = 0;
      f32[o++] = thrA.minDom; f32[o++] = thrA.yMin; f32[o++] = thrA.knee; f32[o++] = thrA.primary;
      f32[o++] = thrB.minDom; f32[o++] = thrB.yMin; f32[o++] = thrB.knee; f32[o++] = thrB.primary;
      f32[o++] = rect.min[0]; f32[o++] = rect.min[1];
      f32[o++] = rect.max[0]; f32[o++] = rect.max[1];
      const u32 = new Uint32Array(f32.buffer);
      u32[o++] = flags >>> 0;
      f32[o++] = radiusPx;
      u32[o++] = 0; u32[o++] = 0;
      queue.writeBuffer(uni, 0, f32.buffer);
    }

    async function readResult() {
      await outRead.mapAsync(GPUMapMode.READ);
      const d = new DataView(outRead.getMappedRange());
      const cx = d.getFloat32(0, true);
      const cy = d.getFloat32(4, true);
      const r  = d.getFloat32(8, true);
      const iq = d.getFloat32(12, true);
      const mass = d.getUint32(16, true);
      const ok = d.getUint32(20, true);
      outRead.unmap();
      return { cx, cy, r, iq, mass, ok };
    }

    return { bestKey, bestStats, outRes, outRead, uni, reset, writeUniform, readResult };
  }

  function createFeed(device, pipelines, sampler, w, h) {
    const texFormat = 'rgba8unorm';
    const frameTex = device.createTexture({
      size: { width: w, height: h },
      format: texFormat,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    const maskTex = device.createTexture({
      size: { width: w, height: h },
      format: texFormat,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    const frameView = frameTex.createView();
    const maskView = maskTex.createView();

    const renderBG = device.createBindGroup({
      layout: pipelines.render.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: frameView },
        { binding: 4, resource: maskView },
        { binding: 5, resource: sampler }
      ]
    });

    let bg1 = null, bg2 = null, pack1 = null, pack2 = null;
    function computeBG1(pack) {
      if (pack1 !== pack) {
        bg1 = device.createBindGroup({
          layout: pipelines.pass1.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: frameView },
            { binding: 1, resource: maskView },
            { binding: 2, resource: { buffer: pack.bestKey } },
            { binding: 3, resource: { buffer: pack.bestStats } },
            { binding: 6, resource: { buffer: pack.uni } }
          ]
        });
        pack1 = pack;
      }
      return bg1;
    }
    function computeBG2(pack) {
      if (pack2 !== pack) {
        bg2 = device.createBindGroup({
          layout: pipelines.pass2.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: frameView },
            { binding: 1, resource: maskView },
            { binding: 3, resource: { buffer: pack.bestStats } },
            { binding: 4, resource: { buffer: pack.outRes } },
            { binding: 6, resource: { buffer: pack.uni } }
          ]
        });
        pack2 = pack;
      }
      return bg2;
    }
    function destroy() {
      frameTex.destroy();
      maskTex.destroy();
    }
    return { w, h, frameTex, maskTex, frameView, maskView, renderBG, computeBG1, computeBG2, destroy };
  }

  const _devState = new WeakMap();
  let _device = null;
  let _format = null;

  async function _ensureDevice() {
    if (_device) return _device;
    if (!('gpu' in navigator)) throw new Error('WebGPU not supported');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    _device = await adapter.requestDevice();
    _format = navigator.gpu.getPreferredCanvasFormat?.() || 'rgba8unorm';
    return _device;
  }

  function _sizeOf(src) {
    const w = src?.codedWidth ?? src?.videoWidth ?? src?.naturalWidth ?? src?.width;
    const h = src?.codedHeight ?? src?.videoHeight ?? src?.naturalHeight ?? src?.height;
    return { w, h };
  }

  async function detectRGB({
    key = 'default',
    source,
    thrA = { primary: 0, minDom: 0.12, yMin: 0.10, knee: 0.10 },
    thrB = { primary: 1, minDom: 0.10, yMin: 0.08, knee: 0.10 },
    radiusPx = 16,
    rect = null,
    previewCanvas = null,
    preview = false,
    activeA = true,
    activeB = true,
    flipY = true
  } = {}) {
    const device = await _ensureDevice();
    if (!source) throw new Error('detectRGB: source required');

    let state = _devState.get(device);
    if (!state) {
      state = { pipelines: null, sampler: null, ctxByKey: new Map() };
      _devState.set(device, state);
    }
    if (!state.pipelines) state.pipelines = await createPipelines(device, { format: _format });
    if (!state.sampler) state.sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

    let ctx = state.ctxByKey.get(key);
    if (!ctx) {
      const pack = createUniformPack(device);
      ctx = { pack, feed: null, defaultRect: { min: new Float32Array([0, 0]), max: new Float32Array([0, 0]) }, canvasCtx: null };
      state.ctxByKey.set(key, ctx);
    }

    const { w, h } = _sizeOf(source);
    if (!(w > 0 && h > 0)) throw new Error('detectRGB: bad source size');
    let resized = false;
    if (!ctx.feed || ctx.feed.w !== w || ctx.feed.h !== h) {
      ctx.feed?.destroy?.();
      ctx.feed = createFeed(device, state.pipelines, state.sampler, w, h);
      ctx.defaultRect.max[0] = w;
      ctx.defaultRect.max[1] = h;
      resized = true;
    }

    if (!rect) rect = ctx.defaultRect;

    device.queue.copyExternalImageToTexture(
      { source, origin: { x: 0, y: 0 }, flipY },
      { texture: ctx.feed.frameTex },
      { width: w, height: h }
    );

    const baseFlags = (preview ? FLAGS.PREVIEW : 0);
    let maskCleared = false;

    async function runTeam(teamFlag) {
      ctx.pack.reset(device.queue);
      ctx.pack.writeUniform(device.queue, thrA, thrB, rect, baseFlags | teamFlag, radiusPx);

      const enc = device.createCommandEncoder();
      if (preview && !maskCleared) {
        enc.beginRenderPass({ colorAttachments: [{ view: ctx.feed.maskView, loadOp: 'clear', storeOp: 'store' }] }).end();
        maskCleared = true;
      }
      const c = enc.beginComputePass();
      c.setPipeline(state.pipelines.pass1);
      c.setBindGroup(0, ctx.feed.computeBG1(ctx.pack));
      c.dispatchWorkgroups(Math.ceil(w / WG_SIZE.X), Math.ceil(h / WG_SIZE.Y));
      c.setPipeline(state.pipelines.pass2);
      c.setBindGroup(0, ctx.feed.computeBG2(ctx.pack));
      c.dispatchWorkgroups(1, 1, 1);
      c.end();
      enc.copyBufferToBuffer(ctx.pack.outRes, 0, ctx.pack.outRead, 0, 24);
      device.queue.submit([enc.finish()]);
      return await ctx.pack.readResult();
    }

    let a = null, b = null;
    if (activeA) a = await runTeam(FLAGS.TEAM_A);
    if (activeB) b = await runTeam(FLAGS.TEAM_B);

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
      const view = ctx.canvasCtx.getCurrentTexture().createView();
      const enc = device.createCommandEncoder();
      const r = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
      r.setPipeline(state.pipelines.render);
      r.setBindGroup(0, ctx.feed.renderBG);
      r.draw(3);
      r.end();
      device.queue.submit([enc.finish()]);
    }

    let label = 'none';
    if (a?.ok && b?.ok) label = 'both';
    else if (a?.ok) label = 'a';
    else if (b?.ok) label = 'b';

    return {
      label,
      a: a?.ok ? { x: a.cx, y: a.cy, r: a.r } : null,
      b: b?.ok ? { x: b.cx, y: b.cy, r: b.r } : null,
      roi: rect,
      size: { w, h },
      resized
    };
  }

  global.GPUSharedRGB = { detectRGB, FLAGS };
})(window);

