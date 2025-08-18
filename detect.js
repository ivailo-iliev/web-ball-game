// GPUShared.detect({ key, source, hsvA6, hsvB6, rect, previewCanvas, preview, activeA, activeB, flipY })
// -> { a:[area,cx,cy], b:[area,cx,cy], w, h, resized }
(function (global) {
  const Cache = { device:null, format:null, code:null, pipes:null, sampler:null, tex:null, texW:0, texH:0, ctx:null, canvasW:0, canvasH:0 };
  const WG = { VOTE_X:16, VOTE_Y:16, REDUCE_X:16, REDUCE_Y:16 };

  const DEF = { downscale: 2, r0: 12, rDelta: 2, nAngles: 48, gradThresh: 0.14, thrRatio: 0.30 };

  function hsvRangeF16(TEAM_INDICES, TABLE, teamName) {
    const idx = TEAM_INDICES[teamName] * 6;
    const h0 = TABLE[idx+0], sMin = TABLE[idx+1], vMin = TABLE[idx+2];
    const hWin = TABLE[idx+3], sMax = TABLE[idx+4], vMax = TABLE[idx+5];
    return new Float32Array([h0 - hWin, sMin, vMin, h0 + hWin, sMax, vMax]);
  }

  async function ensureDevice() {
    if (Cache.device) return { device: Cache.device, format: Cache.format };
    if (!('gpu' in navigator)) throw new Error('WebGPU not supported');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    const device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] });
    const format = navigator.gpu.getPreferredCanvasFormat();
    Cache.device = device; Cache.format = format;
    return { device, format };
  }

  async function createPipelines(device, code, format) {
    if (Cache.pipes && Cache.code === code) return Cache.pipes;
    const mod = device.createShaderModule({ code });
    const render = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs' },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }
    });
    const vote = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'vote_centers' }});
    const r1A  = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'reduce_stage1_A' }});
    const r2A  = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'reduce_stage2_A' }});
    const r1B  = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'reduce_stage1_B' }});
    const r2B  = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'reduce_stage2_B' }});
    const sA   = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'score_A' }});
    const sB   = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'score_B' }});
    Cache.code = code;
    Cache.pipes = { render, vote, r1A, r2A, r1B, r2B, sA, sB };
    return Cache.pipes;
  }

  function makeBuffers(device, detW, detH, nAngles) {
    const info   = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const params = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const accBytes = detW * detH * 4;
    const nWGx = Math.ceil(detW / WG.VOTE_X);
    const nWGy = Math.ceil(detH / WG.VOTE_Y);
    const partialBytes = nWGx * nWGy * 8;
    const resBytes = 32;

    const accumA = device.createBuffer({ size: accBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const partialsA = device.createBuffer({ size: partialBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outResA = device.createBuffer({ size: resBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });

    const accumB = device.createBuffer({ size: accBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const partialsB = device.createBuffer({ size: partialBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outResB = device.createBuffer({ size: resBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });

    const rdA = device.createBuffer({ size: resBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const rdB = device.createBuffer({ size: resBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    return { info, params, accumA, partialsA, outResA, accumB, partialsB, outResB, rdA, rdB };
  }

  function writeInfo(queue, buf, { fullW, fullH, detW, detH, downscale }) {
    const u32 = new Uint32Array(8);
    u32[0]=fullW; u32[1]=fullH; u32[2]=detW; u32[3]=detH; u32[4]=downscale;
    queue.writeBuffer(buf, 0, u32);
  }

  function writeParams(queue, buf, {
    rectMin, rectMax, hsvA6, hsvB6, r0, rDelta, nAngles, gradThresh, thrRatio, activeA, activeB
  }) {
    const f32 = new Float32Array(64);
    const u32 = new Uint32Array(f32.buffer);
    // rect
    f32[0]=rectMin[0]; f32[1]=rectMin[1]; f32[2]=rectMax[0]; f32[3]=rectMax[1];
    // hsvA lo/hi
    f32[4]=hsvA6[0]; f32[5]=hsvA6[1]; f32[6]=hsvA6[2];
    f32[7]=hsvA6[3]; f32[8]=hsvA6[4]; f32[9]=hsvA6[5];
    // hsvB lo/hi
    f32[10]=hsvB6[0]; f32[11]=hsvB6[1]; f32[12]=hsvB6[2];
    f32[13]=hsvB6[3]; f32[14]=hsvB6[4]; f32[15]=hsvB6[5];
    // detection config
    u32[16]=r0; u32[17]=rDelta; u32[18]=nAngles;
    // grad + thr
    f32[20]=gradThresh; f32[21]=thrRatio;
    // toggles
    u32[22]=activeA ? 1 : 0;
    u32[23]=activeB ? 1 : 0;
    queue.writeBuffer(buf, 0, f32);
  }

  async function detect({ key='default', source, hsvA6, hsvB6, rect, previewCanvas=null, preview=false, activeA=true, activeB=true, flipY=true }={}) {
    if (!source) throw new Error('detect(): source is required');
    const { device, format } = await ensureDevice();
    const code = await fetch('shader.wgsl').then(r => r.text());

    const w = source.codedWidth  || source.videoWidth  || source.naturalWidth  || source.width;
    const h = source.codedHeight || source.videoHeight || source.naturalHeight || source.height;

    const detW = Math.ceil(w / DEF.downscale);
    const detH = Math.ceil(h / DEF.downscale);

    // Reuse texture/sampler across frames
    if (!Cache.tex || Cache.texW !== w || Cache.texH !== h) {
      Cache.tex?.destroy?.();
      Cache.tex = device.createTexture({
        size: { width: w, height: h },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
      });
      Cache.texW = w; Cache.texH = h;
    }
    const tex = Cache.tex;
    const view = tex.createView();
    const sampler = Cache.sampler || (Cache.sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }));

    const pipes = await createPipelines(device, code, format);
    const bufs  = makeBuffers(device, detW, detH, DEF.nAngles);

    writeInfo(device.queue, bufs.info, { fullW:w, fullH:h, detW, detH, downscale: DEF.downscale });

    const def6 = new Float32Array([0,0,0,1,1,1]);
    hsvA6 = hsvA6 || def6;
    hsvB6 = hsvB6 || def6;
    const rectMin = rect?.min ? Array.from(rect.min) : [0,0];
    const rectMax = rect?.max ? Array.from(rect.max) : [w,h];

    writeParams(device.queue, bufs.params, {
      rectMin, rectMax, hsvA6, hsvB6,
      r0: DEF.r0, rDelta: DEF.rDelta, nAngles: DEF.nAngles,
      gradThresh: DEF.gradThresh, thrRatio: DEF.thrRatio,
      activeA, activeB
    });

    // Shared bind group for compute passes
    // Per-pass bind groups to match each pipeline's auto layout
    const bg_vote = device.createBindGroup({
      layout: pipes.vote.getBindGroupLayout(0),
      entries: [
        { binding:0, resource: view },
        { binding:1, resource: sampler },
        { binding:2, resource: { buffer: bufs.info } },
        { binding:3, resource: { buffer: bufs.params } },
        { binding:4, resource: { buffer: bufs.accumA } },
        { binding:8, resource: { buffer: bufs.accumB } },
      ],
    });
    const bg_r1A = device.createBindGroup({
      layout: pipes.r1A.getBindGroupLayout(0),
      entries: [
        { binding:2, resource: { buffer: bufs.info } },
        { binding:4, resource: { buffer: bufs.accumA } },
        { binding:5, resource: { buffer: bufs.partialsA } },
      ],
    });
    const bg_r2A = device.createBindGroup({
      layout: pipes.r2A.getBindGroupLayout(0),
      entries: [
        { binding:2, resource: { buffer: bufs.info } },
        { binding:3, resource: { buffer: bufs.params } },
        { binding:5, resource: { buffer: bufs.partialsA } },
        { binding:6, resource: { buffer: bufs.outResA } },
      ],
    });
    const bg_r1B = device.createBindGroup({
      layout: pipes.r1B.getBindGroupLayout(0),
      entries: [
        { binding:2, resource: { buffer: bufs.info } },
        { binding:8, resource: { buffer: bufs.accumB } },
        { binding:9, resource: { buffer: bufs.partialsB } },
      ],
    });
    const bg_r2B = device.createBindGroup({
      layout: pipes.r2B.getBindGroupLayout(0),
      entries: [
        { binding:2, resource: { buffer: bufs.info } },
        { binding:3, resource: { buffer: bufs.params } },
        { binding:9, resource: { buffer: bufs.partialsB } },
        { binding:10, resource: { buffer: bufs.outResB } },
      ],
    });
    const bg_scoreA = device.createBindGroup({
      layout: pipes.sA.getBindGroupLayout(0),
      entries: [
        { binding:0, resource: view },
        { binding:1, resource: sampler },
        { binding:2, resource: { buffer: bufs.info } },
        { binding:3, resource: { buffer: bufs.params } },
        { binding:6, resource: { buffer: bufs.outResA } },
      ],
    });
    const bg_scoreB = device.createBindGroup({
      layout: pipes.sB.getBindGroupLayout(0),
      entries: [
        { binding:0, resource: view },
        { binding:1, resource: sampler },
        { binding:2, resource: { buffer: bufs.info } },
        { binding:3, resource: { buffer: bufs.params } },
        { binding:10, resource: { buffer: bufs.outResB } },
      ],
    });
    const bg_render = device.createBindGroup({
      layout: pipes.render.getBindGroupLayout(0),
      entries: [
        { binding:0, resource: view },
        { binding:1, resource: sampler },
      ],
    });

    // upload frame
    device.queue.copyExternalImageToTexture({ source, flipY }, { texture: tex }, { width: w, height: h });

    // clear buffers
    device.queue.writeBuffer(bufs.accumA, 0, new Uint32Array(detW*detH));
    device.queue.writeBuffer(bufs.accumB, 0, new Uint32Array(detW*detH));
    device.queue.writeBuffer(bufs.outResA, 0, new Uint8Array(32));
    device.queue.writeBuffer(bufs.outResB, 0, new Uint8Array(32));

    // encode passes
    const enc = device.createCommandEncoder();
    {
      const c = enc.beginComputePass();
      c.setPipeline(pipes.vote);   c.setBindGroup(0, bg_vote);
      c.dispatchWorkgroups(Math.ceil(detW/WG.VOTE_X), Math.ceil(detH/WG.VOTE_Y));

      c.setPipeline(pipes.r1A);    c.setBindGroup(0, bg_r1A);
      c.dispatchWorkgroups(Math.ceil(detW/WG.REDUCE_X), Math.ceil(detH/WG.REDUCE_Y));
      c.setPipeline(pipes.r2A);    c.setBindGroup(0, bg_r2A); c.dispatchWorkgroups(1);

      c.setPipeline(pipes.r1B);    c.setBindGroup(0, bg_r1B);
      c.dispatchWorkgroups(Math.ceil(detW/WG.REDUCE_X), Math.ceil(detH/WG.REDUCE_Y));
      c.setPipeline(pipes.r2B);    c.setBindGroup(0, bg_r2B); c.dispatchWorkgroups(1);

      c.setPipeline(pipes.sA);     c.setBindGroup(0, bg_scoreA); c.dispatchWorkgroups(1);
      c.setPipeline(pipes.sB);     c.setBindGroup(0, bg_scoreB); c.dispatchWorkgroups(1);
      c.end();
    }

    // optional render overlay (just the frame)
    if (preview && previewCanvas) {
      if (!Cache.ctx) {
        Cache.ctx = previewCanvas.getContext('webgpu');
      }
      if (Cache.canvasW !== w || Cache.canvasH !== h) {
        previewCanvas.width = w; previewCanvas.height = h;
        Cache.ctx.configure({ device, format, alphaMode:'opaque' });
        Cache.canvasW = w; Cache.canvasH = h;
      }
      const r = enc.beginRenderPass({ colorAttachments: [{ view: Cache.ctx.getCurrentTexture().createView(), loadOp:'clear', storeOp:'store' }] });      r.setPipeline(pipes.render);
      r.setBindGroup(0, bg_render);
      r.draw(3);
      r.end();
    }

    // read back
    enc.copyBufferToBuffer(bufs.outResA, 0, bufs.rdA, 0, 32);
    enc.copyBufferToBuffer(bufs.outResB, 0, bufs.rdB, 0, 32);
    device.queue.submit([enc.finish()]);

    await Promise.all([bufs.rdA.mapAsync(GPUMapMode.READ), bufs.rdB.mapAsync(GPUMapMode.READ)]);
    const dvA = new DataView(bufs.rdA.getMappedRange());
    const dvB = new DataView(bufs.rdB.getMappedRange());

    const A = { cx: dvA.getFloat32(0,true), cy: dvA.getFloat32(4,true), r: dvA.getFloat32(8,true),
                conf: dvA.getFloat32(12,true), cov: dvA.getFloat32(16,true), votes: dvA.getUint32(20,true) };
    const B = { cx: dvB.getFloat32(0,true), cy: dvB.getFloat32(4,true), r: dvB.getFloat32(8,true),
                conf: dvB.getFloat32(12,true), cov: dvB.getFloat32(16,true), votes: dvB.getUint32(20,true) };
    bufs.rdA.unmap(); bufs.rdB.unmap();

    const areaA = Math.PI * A.r * A.r * Math.max(0, Math.min(1, A.cov));
    const areaB = Math.PI * B.r * B.r * Math.max(0, Math.min(1, B.cov));

    const a = new Float32Array([areaA, A.cx, A.cy]);
    const b = new Float32Array([areaB, B.cx, B.cy]);

    return { a, b, w, h, resized: false };
  }

  global.GPUShared = { detect, hsvRangeF16 };
})(window);
