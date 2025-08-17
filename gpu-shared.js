(function (global) {
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

  async function createRunner(device, canvasFormat = 'rgba8unorm') {
    if (!navigator.gpu) {
      throw new Error('WebGPU not supported');
    }
    if (!device?.features?.has?.('shader-f16')) {
      throw new Error('shader-f16 not supported');
    }
    const pipelines = await createPipelines(device, { format: canvasFormat });
    const sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
    const pack = createUniformPack(device);
    pack.hsvA6 = new Uint16Array(6);
    pack.hsvB6 = new Uint16Array(6);
    const ORIGIN = { x: 0, y: 0 };
    const defaultRect = { min: new Float32Array(2), max: new Float32Array(2) };
    let feed = null;

    function ensureFeed(width, height) {
      if (!(width > 0 && height > 0)) {
        throw new Error('ensureFeed: width and height must be positive');
      }
      if (!feed || feed.w !== width || feed.h !== height) {
        feed?.destroy?.();
        feed = createFeed(device, pipelines, sampler, width, height, canvasFormat);
        defaultRect.max[0] = width;
        defaultRect.max[1] = height;
        return true;
      }
      return false;
    }

    async function process({ source, view = null, flags = 0, rect = defaultRect, flipY = true } = {}) {
      if (!feed) {
        throw new Error('process called before ensureFeed');
      }
      if (!source) {
        throw new Error('process: source required');
      }
      pack.resetStats(device.queue);
      pack.writeUniform(device.queue, pack.hsvA6, pack.hsvB6, rect, flags);
      device.queue.copyExternalImageToTexture(
        { source, origin: ORIGIN, flipY },
        { texture: feed.frameTex },
        { width: feed.w, height: feed.h }
      );
      const encoder = device.createCommandEncoder();
      encoder
        .beginRenderPass({ colorAttachments: [{ view: feed.maskView, loadOp: 'clear', storeOp: 'store' }] })
        .end();
      const pass = encoder.beginComputePass({ label: 'detect-compute' });
      pass.setPipeline(pipelines.compute);
      pass.setBindGroup(0, feed.computeBG(pack));
      pass.dispatchWorkgroups(
        Math.ceil(feed.w / WG_SIZE.X),
        Math.ceil(feed.h / WG_SIZE.Y)
      );
      pass.end();
      encoder.copyBufferToBuffer(pack.statsA, 0, pack.readA, 0, 12);
      encoder.copyBufferToBuffer(pack.statsB, 0, pack.readB, 0, 12);
      if (view) {
        const rpass = encoder.beginRenderPass({
          label: 'mask-present',
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }]
        });
        rpass.setPipeline(pipelines.render);
        rpass.setBindGroup(0, feed.renderBG);
        rpass.draw(3);
        rpass.end();
      }
      device.queue.submit([encoder.finish()]);
      return pack.readStats();
    }

    return { ensureFeed, process, pack };
  }

  const GPUShared = {
    WG_SIZE,
    FLAGS,
    createPipelines,
    createUniformPack,
    createFeed,
    float32ToFloat16,
    hsvRangeF16,
    createRunner
  };

  global.GPUShared = GPUShared;
})(window);
