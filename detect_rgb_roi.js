
// detect_rgb_roi.js
// Minimal host-side wrapper for the RGB detector shader with ROI-local outputs.

(function () {
  const WG = { X: 16, Y: 16 };
  const FLAGS = { PREVIEW: 1, TEAM_A: 2, TEAM_B: 4 };

  // Shared device helper (auto-inits if none passed)
  let __device = null;
  async function getDevice(passed) {
    if (passed) return passed;
    if (__device) return __device;
    if (!('gpu' in navigator)) throw new Error('WebGPU not available');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    __device = await adapter.requestDevice();
    return __device;
  }

  async function init(device) {
    const dev = await getDevice(device);
    const module = dev.createShaderModule({ code: await (await fetch('shader_rgb_roi.wgsl')).text() });

    const pass1 = dev.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'pass1' }
    });
    const pass2 = dev.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'pass2' }
    });

    // Storage buffers
    const bestKey = dev.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const bestStats = dev.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outRes = dev.createBuffer({ size: 24, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const outRead = dev.createBuffer({ size: 24, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    // Uniform buffer (std140-like packing; we just write f32s in sequence)
    const uniSize = 4 * ( // floats
      (4) + // Team A
      (4) + // Team B
      (2) + // rMin
      (2) + // rMax
      1 +   // flags (u32)
      1 +   // radius
      2     // pad
    );
    const uni = dev.createBuffer({ size: uniSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    // A mask/overlay texture for preview (RGBA8)
    function makeTextures(w, h) {
      const frameTex = dev.createTexture({
        size: { width: w, height: h },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
      });
      const maskTex = dev.createTexture({
        size: { width: w, height: h },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
      });
      return { frameTex, maskTex };
    }

    function writeUniform(queue, thrA, thrB, rect, flags, radiusPx) {
      // pack floats in the same order as WGSL struct
      const f32 = new Float32Array(uniSize / 4);
      let o = 0;
      // Team A
      f32[o++] = thrA.minDom;  f32[o++] = thrA.yMin;  f32[o++] = thrA.knee;  f32[o++] = thrA.primary;
      // Team B
      f32[o++] = thrB.minDom;  f32[o++] = thrB.yMin;  f32[o++] = thrB.knee;  f32[o++] = thrB.primary;
      // ROI
      f32[o++] = rect.min[0];  f32[o++] = rect.min[1];
      f32[o++] = rect.max[0];  f32[o++] = rect.max[1];
      // flags + radius (treat flags as f32 then rewrite the 5th 32-bit slot as u32)
      const byteView = new Uint8Array(f32.buffer);
      const u32 = new Uint32Array(f32.buffer);
      u32[o++] = flags >>> 0;
      f32[o++] = radiusPx;
      // pad
      u32[o++] = 0; u32[o++] = 0;

      queue.writeBuffer(uni, 0, f32.buffer);
    }

    async function readResult(buffer) {
      await outRead.mapAsync(GPUMapMode.READ);
      const d = new DataView(outRead.getMappedRange());
      const cx = d.getFloat32(0, true);
      const cy = d.getFloat32(4, true);
      const r  = d.getFloat32(8, true);
      const iq = d.getFloat32(12, true);
      const mass = d.getUint32(16, true);
      const ok = d.getUint32(20, true);
      outRead.unmap();
      return { ok, cx, cy, r, iq, mass };
    }

    return {
      pipelines: { pass1, pass2 },
      buffers: { bestKey, bestStats, outRes, outRead, uni },
      makeTextures,
      writeUniform,
      readResult,
      FLAGS,
      device: dev
    };
  }

function sizeOf(source) {
  if ('videoWidth' in source) return { w: source.videoWidth, h: source.videoHeight };
  if ('naturalWidth' in source) return { w: source.naturalWidth, h: source.naturalHeight };
  if ('displayWidth' in source) return { w: source.displayWidth, h: source.displayHeight }; // VideoFrame
  if ('codedWidth' in source)   return { w: source.codedWidth, h: source.codedHeight };     // VideoFrame
  if ('width' in source && 'height' in source) return { w: source.width, h: source.height };
  throw new Error('Unsupported source type for copyExternalImageToTexture()');
}

  async function detectRGB({
    device,
    source,               // HTMLVideoElement/ImageBitmap/HTMLCanvasElement/HTMLImageElement
    thrA = { primary:0, minDom:0.12, yMin:0.10, knee:0.10 },
    thrB = { primary:1, minDom:0.10, yMin:0.08, knee:0.10 },
    radiusPx = 16,
    rect = null,          // { min:[x0,y0], max:[x1,y1] } in ABS coords
    activeA = true,
    activeB = true,
    preview = false,
    previewCanvas = null,
    flipY = true
  } = {}) {
    const { w, h } = sizeOf(source);
    if (!rect) rect = { min:[0,0], max:[w,h] };

    const ctx = await init(device);
    const dev = ctx.device;
    const { frameTex, maskTex } = ctx.makeTextures(w, h);

    const frameView = frameTex.createView();
    const maskView  = maskTex.createView();

    // Copy the frame
    dev.queue.copyExternalImageToTexture(
      { source, flipY },
      { texture: frameTex },
      { width: w, height: h }
    );

    // Helper to run a single team
    async function runFor(flags) {
      // reset best key
      dev.queue.writeBuffer(ctx.buffers.bestKey, 0, new Uint32Array([0]));
      // write uniforms
      ctx.writeUniform(dev.queue, thrA, thrB, rect, flags, radiusPx);

      const bindGroupLayout = ctx.pipelines.pass1.getBindGroupLayout(0);
      // Create separate bind groups per pipeline to match their layouts.
      // PASS 1 expected: 0 (texture_2d), 1 (storageTexture writeonly RGBA8), 3 (storage buf min 4), 4 (storage buf min 24), 6 (uniform)
      const bgl1 = ctx.pipelines.pass1.getBindGroupLayout(0);
      const bg1 = dev.createBindGroup({
        layout: bgl1,
        entries: [
          { binding: 0, resource: frameView },
          { binding: 1, resource: maskTex.createView() },
          { binding: 2, resource: { buffer: ctx.buffers.bestKey } },
          { binding: 3, resource: { buffer: ctx.buffers.bestStats } },
          { binding: 6, resource: { buffer: ctx.buffers.uni } },
        ],
      });
      // PASS 2 typically reduces + writes to outRes; it shouldn’t need textures.
      // Expected bindings: 2: storage buffer, 3: storage buffer, 4: outRes storage buffer, 6: uniform
      const bgl2 = ctx.pipelines.pass2.getBindGroupLayout(0);
      const bg2 = dev.createBindGroup({
        layout: bgl2,
        entries: [
          { binding: 0, resource: frameView },                         // texture_2d<f32>
          { binding: 1, resource: maskView },                          // texture_storage_2d<rgba8unorm, write>
          { binding: 3, resource: { buffer: ctx.buffers.bestStats } }, // array<u32>
          { binding: 4, resource: { buffer: ctx.buffers.outRes } },    // struct OutRes
          { binding: 6, resource: { buffer: ctx.buffers.uni } },       // uniforms
         ],
      });

      const enc = dev.createCommandEncoder();
      // Clear mask if preview
      if (preview) {
        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: maskView, loadOp: 'clear', storeOp: 'store' }]
        });
        rp.end();
      }
      const c = enc.beginComputePass();
      c.setPipeline(ctx.pipelines.pass1);
      c.setBindGroup(0, bg1);
      c.dispatchWorkgroups(Math.ceil(w / WG.X), Math.ceil(h / WG.Y)); // full grid, shader ignores outside ROI
      c.setPipeline(ctx.pipelines.pass2);
      c.setBindGroup(0, bg2);
      c.dispatchWorkgroups(1, 1, 1);
      c.end();
      enc.copyBufferToBuffer(ctx.buffers.outRes, 0, ctx.buffers.outRead, 0, 24);
      dev.queue.submit([enc.finish()]);

      return await ctx.readResult(ctx.buffers.outRead);
    }

    const base = (preview ? ctx.FLAGS.PREVIEW : 0);
    let a = null, b = null, label = 'none';

    if (activeA && !activeB) {
      a = await runFor(base | ctx.FLAGS.TEAM_A);
      label = a.ok ? 'a' : 'none';
    } else if (!activeA && activeB) {
      b = await runFor(base | ctx.FLAGS.TEAM_B);
      label = b.ok ? 'b' : 'none';
    } else {
      a = await runFor(base | ctx.FLAGS.TEAM_A);
      b = await runFor(base | ctx.FLAGS.TEAM_B);
      if (a.ok && b.ok) label = 'both';
      else if (a.ok) label = 'a';
      else if (b.ok) label = 'b';
    }

    // Results are already ROI-local (shader subtracts rect.min)
    const out = {
      label,
      a: a && a.ok ? { x: a.cx, y: a.cy, r: a.r } : null,
      b: b && b.ok ? { x: b.cx, y: b.cy, r: b.r } : null,
      roi: rect,
      size: { w, h }
    };

    // Optional preview composited into previewCanvas by sampling frame+mask externally.
    // --- Render frame + mask to the preview canvas (WebGPU) ---
    if (preview && previewCanvas) {
      const swap = previewCanvas.getContext('webgpu');
      if (swap) {
        swap.configure({ device: dev, format: ctx.canvasFormat, alphaMode: 'premultiplied' });
        const outView = swap.getCurrentTexture().createView();
        const bglR = ctx.pipelines.render.getBindGroupLayout(0);
        const bgR = dev.createBindGroup({
          layout: bglR,
          entries: [
            { binding: 0, resource: frameView },           // tFrame
            { binding: 4, resource: maskView },            // tMask (sampled)
            { binding: 5, resource: dev.createSampler() }, // samp
          ]
        });
        const enc2 = dev.createCommandEncoder();
        const rp = enc2.beginRenderPass({
          colorAttachments: [{ view: outView, loadOp: 'clear', storeOp: 'store' }]
        });
        rp.setPipeline(ctx.pipelines.render);
        rp.setBindGroup(0, bgR);
        rp.draw(3);
        rp.end();
        dev.queue.submit([enc2.finish()]);
      }
    }

    return out;
  }

  window.GPUSharedRGB = { detectRGB, FLAGS };
})();