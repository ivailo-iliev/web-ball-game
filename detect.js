// detect.js — wires the dual-team detector (A & B), preserves ROI + team toggles
// Returns: { team: 'a'|'b'|'both'|'none', A: {x,y,conf,coverage}, B: {x,y,conf,coverage}, radius }

(async function (global) {
  const WG = { VOTE_X: 16, VOTE_Y: 16, REDUCE_X: 16, REDUCE_Y: 16, FINAL: 256 };

  // Calibrated defaults (from your photos); override via call if needed
  const CAL = {
    downscale: 2,
    r0: 12, rDelta: 2, nAngles: 48,
    gradThresh: 0.14, thrRatio: 0.30,
    confAccept: 0.45, coverageMin: 0.35,
    teamA: { rhat: 0.4274, ghat: 0.3844, thr: 0.1827 }, // green
    teamB: { rhat: 0.3726, ghat: 0.3169, thr: 0.0544 }, // red
  };

  async function createPipelines(device, code) {
    const mod = device.createShaderModule({ code });
    const render  = device.createRenderPipeline({ layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs' },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
      primitive: { topology: 'triangle-list' }
    });
    const vote   = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'vote_centers' } });
    const r1A    = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'reduce_stage1_A' } });
    const r2A    = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'reduce_stage2_A' } });
    const r1B    = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'reduce_stage1_B' } });
    const r2B    = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'reduce_stage2_B' } });
    const scoreA = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'score_A' } });
    const scoreB = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'score_B' } });
    return { render, vote, r1A, r2A, r1B, r2B, scoreA, scoreB };
  }

  function makeUniforms(device) {
    const info   = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const params = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return { info, params };
  }

  function makeStorage(device, detW, detH, nAngles) {
    const accBytes = detW * detH * 4;
    const nWGx = Math.ceil(detW / WG.VOTE_X);
    const nWGy = Math.ceil(detH / WG.VOTE_Y);
    const partialBytes = nWGx * nWGy * 8; // Pair{u32,u32}
    const maskWords = Math.ceil(nAngles / 32);
    const angleBytes = maskWords * 4;
    const resBytes = 32;

    const accumA = device.createBuffer({ size: accBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const partialsA = device.createBuffer({ size: partialBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outResA = device.createBuffer({ size: resBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const angleMaskA = device.createBuffer({ size: angleBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

    const accumB = device.createBuffer({ size: accBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const partialsB = device.createBuffer({ size: partialBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outResB = device.createBuffer({ size: resBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const angleMaskB = device.createBuffer({ size: angleBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

    const rdA = device.createBuffer({ size: resBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const rdB = device.createBuffer({ size: resBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    return { accumA, partialsA, outResA, angleMaskA, accumB, partialsB, outResB, angleMaskB, rdA, rdB, nWGx, nWGy };
  }

  function writeImageInfo(queue, buf, { fullW, fullH, detW, detH, downscale }) {
    const u32 = new Uint32Array(8);
    u32[0]=fullW; u32[1]=fullH; u32[2]=detW; u32[3]=detH; u32[4]=downscale;
    queue.writeBuffer(buf, 0, u32);
  }

  function writeParams(queue, buf, P) {
    // tightly pack in order defined in WGSL (and we oversized buffer to be safe)
    const f32 = new Float32Array(64);
    const u32 = new Uint32Array(f32.buffer);

    // rectMin/rectMax
    f32[0] = P.rectMin[0]; f32[1] = P.rectMin[1];
    f32[2] = P.rectMax[0]; f32[3] = P.rectMax[1];

    // r0, rDelta, nAngles, pad
    u32[4] = P.r0; u32[5] = P.rDelta; u32[6] = P.nAngles;

    f32[8] = P.gradThresh;
    f32[9] = P.thrRatio;
    f32[10]= P.confAccept;
    f32[11]= P.coverageMin;

    u32[12] = P.activeA ? 1 : 0;
    u32[13] = P.activeB ? 1 : 0;

    f32[16] = P.teamA_nrgb[0]; f32[17] = P.teamA_nrgb[1]; f32[18] = P.teamA_thr;
    f32[20] = P.teamB_nrgb[0]; f32[21] = P.teamB_nrgb[1]; f32[22] = P.teamB_thr;

    queue.writeBuffer(buf, 0, f32);
  }

  function makeBindGroups(device, pipes, sampler, frameView, uni, sto) {
    const entries = [
      { binding: 0, resource: frameView },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer: uni.info } },
      { binding: 3, resource: { buffer: uni.params } },
      { binding: 4, resource: { buffer: sto.accumA } },
      { binding: 5, resource: { buffer: sto.partialsA } },
      { binding: 6, resource: { buffer: sto.outResA } },
      { binding: 7, resource: { buffer: sto.angleMaskA } },
      { binding: 8, resource: { buffer: sto.accumB } },
      { binding: 9, resource: { buffer: sto.partialsB } },
      { binding: 10, resource: { buffer: sto.outResB } },
      { binding: 11, resource: { buffer: sto.angleMaskB } },
    ];
    return {
      vote:   device.createBindGroup({ layout: pipes.vote.getBindGroupLayout(0),   entries }),
      r1A:    device.createBindGroup({ layout: pipes.r1A.getBindGroupLayout(0),    entries }),
      r2A:    device.createBindGroup({ layout: pipes.r2A.getBindGroupLayout(0),    entries }),
      r1B:    device.createBindGroup({ layout: pipes.r1B.getBindGroupLayout(0),    entries }),
      r2B:    device.createBindGroup({ layout: pipes.r2B.getBindGroupLayout(0),    entries }),
      scoreA: device.createBindGroup({ layout: pipes.scoreA.getBindGroupLayout(0), entries }),
      scoreB: device.createBindGroup({ layout: pipes.scoreB.getBindGroupLayout(0), entries }),
      render: device.createBindGroup({ layout: pipes.render.getBindGroupLayout(0), entries: [
        { binding: 0, resource: frameView },
        { binding: 1, resource: sampler },
        // NOTE: render shader reads outResA/outResB internally via group 0 binding 6/10 already bound in compute;
        // for safety we include them through the same entries array if your pipeline layout shares group 0.
      ]})
    };
  }

  async function detect({
    source,                  // HTMLVideoElement / HTMLImageElement / ImageBitmap / VideoFrame
    previewCanvas = null,
    preview = false,
    roi = null,              // [xMin, yMin, xMax, yMax] in full-res pixels
    activeA = true,
    activeB = true,
    downscale = CAL.downscale,
    overrides = {},          // override CAL params if needed
    shaderCode = null,       // pass shader code string if not fetching from file
  } = {}) {
    if (!('gpu' in navigator)) throw new Error('WebGPU not available');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    const device  = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] });
    const format  = navigator.gpu.getPreferredCanvasFormat();

    const code = shaderCode || await fetch('shader.wgsl').then(r => r.text());
    const pipes = await createPipelines(device, code);
    const sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

    const w = source.videoWidth || source.naturalWidth || source.width;
    const h = source.videoHeight || source.naturalHeight || source.height;
    const detW = Math.ceil(w / downscale);
    const detH = Math.ceil(h / downscale);

    const frameTex = device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
    const frameView = frameTex.createView();

    const uni = makeUniforms(device);
    const sto = makeStorage(device, detW, detH, CAL.nAngles);

    const bgs = makeBindGroups(device, pipes, sampler, frameView, uni, sto);

    // uniforms
    const rect = roi || [0, 0, w, h];
    writeImageInfo(device.queue, uni.info, { fullW: w, fullH: h, detW, detH, downscale });
    const P = {
      rectMin: [rect[0], rect[1]],
      rectMax: [rect[2], rect[3]],
      r0: overrides.r0 ?? CAL.r0,
      rDelta: overrides.rDelta ?? CAL.rDelta,
      nAngles: overrides.nAngles ?? CAL.nAngles,
      gradThresh: overrides.gradThresh ?? CAL.gradThresh,
      thrRatio: overrides.thrRatio ?? CAL.thrRatio,
      confAccept: overrides.confAccept ?? CAL.confAccept,
      coverageMin: overrides.coverageMin ?? CAL.coverageMin,
      activeA, activeB,
      teamA_nrgb: [overrides.teamA?.rhat ?? CAL.teamA.rhat, overrides.teamA?.ghat ?? CAL.teamA.ghat],
      teamA_thr: overrides.teamA?.thr ?? CAL.teamA.thr,
      teamB_nrgb: [overrides.teamB?.rhat ?? CAL.teamB.rhat, overrides.teamB?.ghat ?? CAL.teamB.ghat],
      teamB_thr: overrides.teamB?.thr ?? CAL.teamB.thr,
    };
    writeParams(device.queue, uni.params, P);

    // preview
    let ctx = null;
    if (preview && previewCanvas) {
      previewCanvas.width = w; previewCanvas.height = h;
      ctx = previewCanvas.getContext('webgpu');
      ctx.configure({ device, format, alphaMode: 'opaque' });
    }

    // upload frame
    device.queue.copyExternalImageToTexture(
      { source, flipY: true },
      { texture: frameTex },
      { width: w, height: h }
    );

    // clear
    device.queue.writeBuffer(sto.accumA, 0, new Uint32Array(detW * detH));
    device.queue.writeBuffer(sto.accumB, 0, new Uint32Array(detW * detH));
    device.queue.writeBuffer(sto.angleMaskA, 0, new Uint32Array(Math.ceil(CAL.nAngles/32)));
    device.queue.writeBuffer(sto.angleMaskB, 0, new Uint32Array(Math.ceil(CAL.nAngles/32)));
    device.queue.writeBuffer(sto.outResA, 0, new Uint8Array(32));
    device.queue.writeBuffer(sto.outResB, 0, new Uint8Array(32));

    // commands
    const enc = device.createCommandEncoder();

    // compute pipeline: vote -> reduceA -> reduceB -> scoreA -> scoreB
    {
      const c = enc.beginComputePass();
      c.setBindGroup(0, bgs.vote);
      c.setPipeline(pipes.vote);
      c.dispatchWorkgroups(Math.ceil(detW / WG.VOTE_X), Math.ceil(detH / WG.VOTE_Y));

      c.setPipeline(pipes.r1A); c.setBindGroup(0, bgs.r1A);
      c.dispatchWorkgroups(Math.ceil(detW / WG.REDUCE_X), Math.ceil(detH / WG.REDUCE_Y));
      c.setPipeline(pipes.r2A); c.setBindGroup(0, bgs.r2A); c.dispatchWorkgroups(1);

      c.setPipeline(pipes.r1B); c.setBindGroup(0, bgs.r1B);
      c.dispatchWorkgroups(Math.ceil(detW / WG.REDUCE_X), Math.ceil(detH / WG.REDUCE_Y));
      c.setPipeline(pipes.r2B); c.setBindGroup(0, bgs.r2B); c.dispatchWorkgroups(1);

      c.setPipeline(pipes.scoreA); c.setBindGroup(0, bgs.scoreA); c.dispatchWorkgroups(1);
      c.setPipeline(pipes.scoreB); c.setBindGroup(0, bgs.scoreB); c.dispatchWorkgroups(1);
      c.end();
    }

    // copy out results for CPU read
    enc.copyBufferToBuffer(sto.outResA, 0, sto.rdA, 0, 32);
    enc.copyBufferToBuffer(sto.outResB, 0, sto.rdB, 0, 32);

    // preview pass
    if (preview && ctx) {
      const view = ctx.getCurrentTexture().createView();
      const r = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
      r.setPipeline(pipes.render);
      r.setBindGroup(0, bgs.vote); // shares same group/buffers as compute
      r.draw(3);
      r.end();
    }

    device.queue.submit([enc.finish()]);

    // read back
    await Promise.all([sto.rdA.mapAsync(GPUMapMode.READ), sto.rdB.mapAsync(GPUMapMode.READ)]);
    const dvA = new DataView(sto.rdA.getMappedRange());
    const dvB = new DataView(sto.rdB.getMappedRange());

    const A = {
      x: dvA.getFloat32(0, true),
      y: dvA.getFloat32(4, true),
      radius: dvA.getFloat32(8, true),
      conf: dvA.getFloat32(12, true),
      coverage: dvA.getFloat32(16, true),
      votes: dvA.getUint32(20, true)
    };
    const B = {
      x: dvB.getFloat32(0, true),
      y: dvB.getFloat32(4, true),
      radius: dvB.getFloat32(8, true),
      conf: dvB.getFloat32(12, true),
      coverage: dvB.getFloat32(16, true),
      votes: dvB.getUint32(20, true)
    };
    sto.rdA.unmap(); sto.rdB.unmap();

    // decide detections per your rule: conf OR coverage
    const okA = activeA && ((A.conf >= P.confAccept) || (A.coverage >= P.coverageMin));
    const okB = activeB && ((B.conf >= P.confAccept) || (B.coverage >= P.coverageMin));

    const team = okA && okB ? 'both' : okA ? 'a' : okB ? 'b' : 'none';

    return {
      team,
      A: okA ? { x: A.x, y: A.y, conf: A.conf, coverage: A.coverage } : null,
      B: okB ? { x: B.x, y: B.y, conf: B.conf, coverage: B.coverage } : null,
      radius: A.radius || B.radius || (CAL.r0 * downscale),
      roi: rect,
      detDims: { detW, detH },
    };
  }

  // export
  global.DualBallDetect = { detect, CAL };
})(window);
