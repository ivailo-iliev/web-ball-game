// shader.wgsl — dual-team circle detector (HSV gate, ROI, shape-first)
enable f16;

struct ImageInfo {
  fullW  : u32, fullH  : u32,
  detW   : u32, detH   : u32,
  downscale : u32, _padI : u32,
};

struct Params {
  // ROI (full-res px)
  rectMin : vec2<f32>,
  rectMax : vec2<f32>,

  // HSV ranges (low & high), per team
  hsvA_lo : vec3<f32>, hsvA_hi : vec3<f32>,
  hsvB_lo : vec3<f32>, hsvB_hi : vec3<f32>,

  // detection config
  r0         : u32,         // at detection scale
  rDelta     : u32,         // ±
  nAngles    : u32,
  _pad0      : u32,

  gradThresh : f32,         // <=0 -> 0.14
  thrRatio   : f32,         // 0.30 -> keep top 70% angles

  // toggles
  activeA    : u32,
  activeB    : u32,
  _pad1      : vec2<u32>,
};

struct Pair {
  value: u32,
  index: u32,
};

struct TeamResult {
  cx      : f32,    // full-res px
  cy      : f32,
  radius  : f32,    // full-res px
  conf    : f32,    // votes / expected
  coverage: f32,    // 0..1
  votes   : u32,
  _padR   : u32,
};

@group(0) @binding(0) var videoTex : texture_2d<f32>;
@group(0) @binding(1) var samp     : sampler;

@group(0) @binding(2) var<uniform> I : ImageInfo;
@group(0) @binding(3) var<uniform> U : Params;

@group(0) @binding(4) var<storage, read_write> accumA : array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> partialsA : array<Pair>;
@group(0) @binding(6) var<storage, read_write> outResA : TeamResult;
@group(0) @binding(7) var<storage, read_write> angleMaskA : array<u32>;

@group(0) @binding(8)  var<storage, read_write> accumB : array<atomic<u32>>;
@group(0) @binding(9)  var<storage, read_write> partialsB : array<Pair>;
@group(0) @binding(10) var<storage, read_write> outResB : TeamResult;
@group(0) @binding(11) var<storage, read_write> angleMaskB : array<u32>;

const PI : f32 = 3.14159265358979323846;

fn luma(rgb: vec3<f32>) -> f32 { return dot(rgb, vec3<f32>(0.299, 0.587, 0.114)); }

fn rgb2hsv(c: vec3<f32>) -> vec3<f32> {
  let K = vec4<f32>(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  let p = mix(vec4<f32>(c.bg, K.wz), vec4<f32>(c.gb, K.xy), step(c.b, c.g));
  let q = mix(vec4<f32>(p.xyw, c.r), vec4<f32>(c.r, p.yzx), step(p.x, c.r));
  let d = q.x - min(q.w, q.y);
  let e = 1.0e-10;
  let h = abs(q.z + (q.w - q.y) / (6.0 * d + e));
  let s = d / (q.x + e);
  let v = q.x;
  return vec3<f32>(h, s, v);
}

fn hueInRange(h: f32, lo: f32, hi: f32) -> bool {
  let hlo = fract(lo);
  let hhi = fract(hi);
  if (hlo <= hhi) {
    return (h >= hlo && h <= hhi);
  } else {
    // wrap-around
    return (h >= hlo || h <= hhi);
  }
}

fn hsvInRange(hsv: vec3<f32>, lo: vec3<f32>, hi: vec3<f32>) -> bool {
  return hueInRange(hsv.x, lo.x, hi.x) &&
         hsv.y >= lo.y && hsv.y <= hi.y &&
         hsv.z >= lo.z && hsv.z <= hi.z;
}

fn detUV(ix: i32, iy: i32) -> vec2<f32> {
  let d = vec2<f32>(f32(I.detW), f32(I.detH));
  return (vec2<f32>(f32(ix), f32(iy)) + vec2<f32>(0.5)) / d;
}

fn sobel_at(ix: i32, iy: i32) -> vec3<f32> {
  var g00 = luma(textureSampleLevel(videoTex, samp, detUV(ix-1, iy-1), 0.0).rgb);
  var g01 = luma(textureSampleLevel(videoTex, samp, detUV(ix,   iy-1), 0.0).rgb);
  var g02 = luma(textureSampleLevel(videoTex, samp, detUV(ix+1, iy-1), 0.0).rgb);
  var g10 = luma(textureSampleLevel(videoTex, samp, detUV(ix-1, iy),   0.0).rgb);
  var g11 = luma(textureSampleLevel(videoTex, samp, detUV(ix,   iy),   0.0).rgb);
  var g12 = luma(textureSampleLevel(videoTex, samp, detUV(ix+1, iy),   0.0).rgb);
  var g20 = luma(textureSampleLevel(videoTex, samp, detUV(ix-1, iy+1), 0.0).rgb);
  var g21 = luma(textureSampleLevel(videoTex, samp, detUV(ix,   iy+1), 0.0).rgb);
  var g22 = luma(textureSampleLevel(videoTex, samp, detUV(ix+1, iy+1), 0.0).rgb);

  let gx = (-1.0*g00 + 1.0*g02) + (-2.0*g10 + 2.0*g12) + (-1.0*g20 + 1.0*g22);
  let gy = ( 1.0*g00 + 2.0*g01 + 1.0*g02) + (-1.0*g20 - 2.0*g21 - 1.0*g22);
  let mag = sqrt(gx*gx + gy*gy) + 1.0e-6;
  return vec3<f32>(gx, gy, mag);
}

fn insideROI_full(px: f32, py: f32) -> bool {
  return px >= U.rectMin.x && px < U.rectMax.x &&
         py >= U.rectMin.y && py < U.rectMax.y;
}

// ---------------- Pass 1: vote into A & B accumulators ----------------
@compute @workgroup_size(16,16)
fn vote_centers(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= I.detW || gid.y >= I.detH) { return; }
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x <= 0 || y <= 0 || x >= i32(I.detW)-1 || y >= i32(I.detH)-1) { return; }

  // ROI (map det -> full px)
  let scale = f32(I.downscale);
  let px = (f32(x) + 0.5) * scale;
  let py = (f32(y) + 0.5) * scale;
  if (!insideROI_full(px, py)) { return; }

  // gradient gate
  let G = sobel_at(x, y);
  let thr = select(U.gradThresh, 0.14, U.gradThresh <= 0.0);
  if (G.z < thr) { return; }

  // color gate using HSV
  let col = textureSampleLevel(videoTex, samp, detUV(x, y), 0.0).rgb;
  let hsv = rgb2hsv(col);
  let hitA = (U.activeA == 1u) && hsvInRange(hsv, U.hsvA_lo, U.hsvA_hi);
  let hitB = (U.activeB == 1u) && hsvInRange(hsv, U.hsvB_lo, U.hsvB_hi);
  if (!(hitA || hitB)) { return; }

  // edge-normal voting
  let n = normalize(vec2<f32>(G.x, G.y));
  let r0 = f32(i32(U.r0));
  let rDelta = i32(U.rDelta);
  for (var dr: i32 = -rDelta; dr <= rDelta; dr = dr + 1) {
    let r = r0 + f32(dr);
    let cx = i32(round(f32(x) - r * n.x));
    let cy = i32(round(f32(y) - r * n.y));
    if (cx >= 0 && cy >= 0 && cx < i32(I.detW) && cy < i32(I.detH)) {
      let idx = u32(cy) * I.detW + u32(cx);
      if (hitA) { atomicAdd(&accumA[idx], 1u); }
      if (hitB) { atomicAdd(&accumB[idx], 1u); }
    }
  }
}

// ---------------- Reductions per team ----------------
var<workgroup> sMaxVal : array<u32, 256>;
var<workgroup> sMaxIdx : array<u32, 256>;

@compute @workgroup_size(16,16)
fn reduce_stage1_A(@builtin(workgroup_id) wid: vec3<u32>,
                   @builtin(local_invocation_id) lid: vec3<u32>,
                   @builtin(local_invocation_index) lindex: u32) {
  let gx = wid.x * 16u + lid.x;
  let gy = wid.y * 16u + lid.y;
  var val : u32 = 0u;
  var idx : u32 = 0u;
  if (gx < I.detW && gy < I.detH) {
    idx = gy * I.detW + gx;
    val = atomicLoad(&accumA[idx]);
  }
  sMaxVal[lindex] = val; sMaxIdx[lindex] = idx;
  workgroupBarrier();

  var stride : u32 = 128u;
  loop {
    if (stride == 0u) { break; }
    if (lindex < stride) {
      let a = sMaxVal[lindex];
      let b = sMaxVal[lindex + stride];
      if (b > a) { sMaxVal[lindex] = b; sMaxIdx[lindex] = sMaxIdx[lindex + stride]; }
    }
    workgroupBarrier();
    stride = stride / 2u;
  }
  if (lindex == 0u) {
    let flat = wid.y * ((I.detW + 15u)/16u) + wid.x;
    partialsA[flat].value = sMaxVal[0];
    partialsA[flat].index = sMaxIdx[0];
  }
}

@compute @workgroup_size(256)
fn reduce_stage2_A(@builtin(local_invocation_index) li: u32) {
  let nWGx = (I.detW + 15u)/16u;
  let nWGy = (I.detH + 15u)/16u;
  let N = nWGx * nWGy;
  var v : u32 = 0u; var idx : u32 = 0u;
  if (li < N) { v = partialsA[li].value; idx = partialsA[li].index; }
  sMaxVal[li] = v; sMaxIdx[li] = idx;
  workgroupBarrier();

  var stride: u32 = 128u;
  loop {
    if (stride == 0u) { break; }
    if (li < stride) {
      let a = sMaxVal[li];
      let b = sMaxVal[li + stride];
      if (b > a) { sMaxVal[li] = b; sMaxIdx[li] = sMaxIdx[li + stride]; }
    }
    workgroupBarrier();
    stride = stride / 2u;
  }
  if (li == 0u) {
    let bestIdx = sMaxIdx[0];
    let bestVal = sMaxVal[0];
    let cx_det = f32(bestIdx % I.detW) + 0.5;
    let cy_det = f32(bestIdx / I.detW) + 0.5;
    let scale = f32(I.downscale);

    outResA.cx = cx_det * scale;
    outResA.cy = cy_det * scale;
    outResA.radius = f32(U.r0) * scale;
    outResA.votes = bestVal;

    let expected = (2.0 * PI * f32(U.r0)) * f32(2u*U.rDelta + 1u) + 1.0;
    outResA.conf = f32(bestVal) / expected;
    outResA.coverage = 0.0;
  }
}

@compute @workgroup_size(16,16)
fn reduce_stage1_B(@builtin(workgroup_id) wid: vec3<u32>,
                   @builtin(local_invocation_id) lid: vec3<u32>,
                   @builtin(local_invocation_index) lindex: u32) {
  let gx = wid.x * 16u + lid.x;
  let gy = wid.y * 16u + lid.y;
  var val : u32 = 0u;
  var idx : u32 = 0u;
  if (gx < I.detW && gy < I.detH) {
    idx = gy * I.detW + gx;
    val = atomicLoad(&accumB[idx]);
  }
  sMaxVal[lindex] = val; sMaxIdx[lindex] = idx;
  workgroupBarrier();

  var stride : u32 = 128u;
  loop {
    if (stride == 0u) { break; }
    if (lindex < stride) {
      let a = sMaxVal[lindex];
      let b = sMaxVal[lindex + stride];
      if (b > a) { sMaxVal[lindex] = b; sMaxIdx[lindex] = sMaxIdx[lindex + stride]; }
    }
    workgroupBarrier();
    stride = stride / 2u;
  }
  if (lindex == 0u) {
    let flat = wid.y * ((I.detW + 15u)/16u) + wid.x;
    partialsB[flat].value = sMaxVal[0];
    partialsB[flat].index = sMaxIdx[0];
  }
}

@compute @workgroup_size(256)
fn reduce_stage2_B(@builtin(local_invocation_index) li: u32) {
  let nWGx = (I.detW + 15u)/16u;
  let nWGy = (I.detH + 15u)/16u;
  let N = nWGx * nWGy;
  var v : u32 = 0u; var idx : u32 = 0u;
  if (li < N) { v = partialsB[li].value; idx = partialsB[li].index; }
  sMaxVal[li] = v; sMaxIdx[li] = idx;
  workgroupBarrier();

  var stride: u32 = 128u;
  loop {
    if (stride == 0u) { break; }
    if (li < stride) {
      let a = sMaxVal[li];
      let b = sMaxVal[li + stride];
      if (b > a) { sMaxVal[li] = b; sMaxIdx[li] = sMaxIdx[li + stride]; }
    }
    workgroupBarrier();
    stride = stride / 2u;
  }
  if (li == 0u) {
    let bestIdx = sMaxIdx[0];
    let bestVal = sMaxVal[0];
    let cx_det = f32(bestIdx % I.detW) + 0.5;
    let cy_det = f32(bestIdx / I.detW) + 0.5;
    let scale = f32(I.downscale);

    outResB.cx = cx_det * scale;
    outResB.cy = cy_det * scale;
    outResB.radius = f32(U.r0) * scale;
    outResB.votes = bestVal;

    let expected = (2.0 * PI * f32(U.r0)) * f32(2u*U.rDelta + 1u) + 1.0;
    outResB.conf = f32(bestVal) / expected;
    outResB.coverage = 0.0;
  }
}

// -------------- Pass 3A: angular support for A --------------
@compute @workgroup_size(64)
fn score_A(@builtin(local_invocation_index) li: u32) {
  if (li == 0u) {
    let words = (U.nAngles + 31u) / 32u;
    for (var w: u32 = 0u; w < words; w = w + 1u) { angleMaskA[w] = 0u; }
  }
  workgroupBarrier();

  let nA = U.nAngles;
  var localMax : f32 = 0.0;
  let r_full = outResA.radius;
  let cx = outResA.cx;
  let cy = outResA.cy;

  for (var i: u32 = li; i < nA; i = i + 64u) {
    let theta = 2.0 * PI * f32(i) / f32(nA);
    let dir = vec2<f32>(cos(theta), sin(theta));
    var best : f32 = 0.0;
    for (var k: i32 = -2; k <= 2; k = k + 1) {
      let p = vec2<f32>(cx, cy) + (r_full + f32(k)) * dir;
      let uv = p / vec2<f32>(f32(I.fullW), f32(I.fullH));
      if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) { continue; }
      let c  = luma(textureSampleLevel(videoTex, samp, uv, 0.0).rgb);
      let cxp = luma(textureSampleLevel(videoTex, samp, uv + vec2<f32>(1.0/f32(I.fullW), 0.0), 0.0).rgb);
      let cyp = luma(textureSampleLevel(videoTex, samp, uv + vec2<f32>(0.0, 1.0/f32(I.fullH)), 0.0).rgb);
      let gx = cxp - c;
      let gy = cyp - c;
      let mag = sqrt(gx*gx + gy*gy);
      let dotn = (gx*dir.x + gy*dir.y) / (mag + 1.0e-6);
      if (abs(dotn) < 0.75) { continue; }
      if (mag > best) { best = mag; }
    }
    if (best > localMax) { localMax = best; }
  }

  // reduce to maxResp
  var tmpMax : array<u32, 64>;
  tmpMax[li] = bitcast<u32>(localMax);
  workgroupBarrier();
  var stride : u32 = 32u;
  loop {
    if (stride == 0u) { break; }
    if (li < stride) {
      let a = bitcast<f32>(tmpMax[li]);
      let b = bitcast<f32>(tmpMax[li + stride]);
      if (b > a) { tmpMax[li] = bitcast<u32>(b); }
    }
    workgroupBarrier();
    stride = stride / 2u;
  }
  let maxResp = bitcast<f32>(tmpMax[0]);
  let T = maxResp * (1.0 - U.thrRatio);

  var countSupported : u32 = 0u;
  for (var i: u32 = li; i < nA; i = i + 64u) {
    let theta = 2.0 * PI * f32(i) / f32(nA);
    let dir = vec2<f32>(cos(theta), sin(theta));
    var best : f32 = 0.0;
    for (var k: i32 = -2; k <= 2; k = k + 1) {
      let p = vec2<f32>(cx, cy) + (r_full + f32(k)) * dir;
      let uv = p / vec2<f32>(f32(I.fullW), f32(I.fullH));
      if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) { continue; }
      let c  = luma(textureSampleLevel(videoTex, samp, uv, 0.0).rgb);
      let cxp = luma(textureSampleLevel(videoTex, samp, uv + vec2<f32>(1.0/f32(I.fullW), 0.0), 0.0).rgb);
      let cyp = luma(textureSampleLevel(videoTex, samp, uv + vec2<f32>(0.0, 1.0/f32(I.fullH)), 0.0).rgb);
      let gx = cxp - c;
      let gy = cyp - c;
      let mag = sqrt(gx*gx + gy*gy);
      let dotn = (gx*dir.x + gy*dir.y) / (mag + 1.0e-6);
      if (abs(dotn) < 0.75) { continue; }
      if (mag > best) { best = mag; }
    }
    if (best >= T && best > 0.0) {
      let w = i / 32u;
      let b = i & 31u;
      atomicOr(&(angleMaskA[w]), 1u << b);
      countSupported = countSupported + 1u;
    }
  }

  var tmpCount : array<u32, 64>;
  tmpCount[li] = countSupported;
  workgroupBarrier();
  var stride2 : u32 = 32u;
  loop {
    if (stride2 == 0u) { break; }
    if (li < stride2) { tmpCount[li] = tmpCount[li] + tmpCount[li + stride2]; }
    workgroupBarrier();
    stride2 = stride2 / 2u;
  }
  if (li == 0u) { outResA.coverage = f32(tmpCount[0]) / f32(nA); }
}

// -------------- Pass 3B: angular support for B --------------
@compute @workgroup_size(64)
fn score_B(@builtin(local_invocation_index) li: u32) {
  if (li == 0u) {
    let words = (U.nAngles + 31u) / 32u;
    for (var w: u32 = 0u; w < words; w = w + 1u) { angleMaskB[w] = 0u; }
  }
  workgroupBarrier();

  let nA = U.nAngles;
  var localMax : f32 = 0.0;
  let r_full = outResB.radius;
  let cx = outResB.cx;
  let cy = outResB.cy;

  for (var i: u32 = li; i < nA; i = i + 64u) {
    let theta = 2.0 * PI * f32(i) / f32(nA);
    let dir = vec2<f32>(cos(theta), sin(theta));
    var best : f32 = 0.0;
    for (var k: i32 = -2; k <= 2; k = k + 1) {
      let p = vec2<f32>(cx, cy) + (r_full + f32(k)) * dir;
      let uv = p / vec2<f32>(f32(I.fullW), f32(I.fullH));
      if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) { continue; }
      let c  = luma(textureSampleLevel(videoTex, samp, uv, 0.0).rgb);
      let cxp = luma(textureSampleLevel(videoTex, samp, uv + vec2<f32>(1.0/f32(I.fullW), 0.0), 0.0).rgb);
      let cyp = luma(textureSampleLevel(videoTex, samp, uv + vec2<f32>(0.0, 1.0/f32(I.fullH)), 0.0).rgb);
      let gx = cxp - c;
      let gy = cyp - c;
      let mag = sqrt(gx*gx + gy*gy);
      let dotn = (gx*dir.x + gy*dir.y) / (mag + 1.0e-6);
      if (abs(dotn) < 0.75) { continue; }
      if (mag > best) { best = mag; }
    }
    if (best > localMax) { localMax = best; }
  }

  var tmpMax : array<u32, 64>;
  tmpMax[li] = bitcast<u32>(localMax);
  workgroupBarrier();
  var stride : u32 = 32u;
  loop {
    if (stride == 0u) { break; }
    if (li < stride) {
      let a = bitcast<f32>(tmpMax[li]);
      let b = bitcast<f32>(tmpMax[li + stride]);
      if (b > a) { tmpMax[li] = bitcast<u32>(b); }
    }
    workgroupBarrier();
    stride = stride / 2u;
  }
  let maxResp = bitcast<f32>(tmpMax[0]);
  let T = maxResp * (1.0 - U.thrRatio);

  var countSupported : u32 = 0u;
  for (var i: u32 = li; i < nA; i = i + 64u) {
    let theta = 2.0 * PI * f32(i) / f32(nA);
    let dir = vec2<f32>(cos(theta), sin(theta));
    var best : f32 = 0.0;
    for (var k: i32 = -2; k <= 2; k = k + 1) {
      let p = vec2<f32>(cx, cy) + (r_full + f32(k)) * dir;
      let uv = p / vec2<f32>(f32(I.fullW), f32(I.fullH));
      if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) { continue; }
      let c  = luma(textureSampleLevel(videoTex, samp, uv, 0.0).rgb);
      let cxp = luma(textureSampleLevel(videoTex, samp, uv + vec2<f32>(1.0/f32(I.fullW), 0.0), 0.0).rgb);
      let cyp = luma(textureSampleLevel(videoTex, samp, uv + vec2<f32>(0.0, 1.0/f32(I.fullH)), 0.0).rgb);
      let gx = cxp - c;
      let gy = cyp - c;
      let mag = sqrt(gx*gx + gy*gy);
      let dotn = (gx*dir.x + gy*dir.y) / (mag + 1.0e-6);
      if (abs(dotn) < 0.75) { continue; }
      if (mag > best) { best = mag; }
    }
    if (best >= T && best > 0.0) {
      let w = i / 32u;
      let b = i & 31u;
      atomicOr(&(angleMaskB[w]), 1u << b);
      countSupported = countSupported + 1u;
    }
  }

  var tmpCount : array<u32, 64>;
  tmpCount[li] = countSupported;
  workgroupBarrier();
  var stride2 : u32 = 32u;
  loop {
    if (stride2 == 0u) { break; }
    if (li < stride2) { tmpCount[li] = tmpCount[li] + tmpCount[li + stride2]; }
    workgroupBarrier();
    stride2 = stride2 / 2u;
  }
  if (li == 0u) { outResB.coverage = f32(tmpCount[0]) / f32(nA); }
}

// -------- Render overlay (simple: just draw the frame) --------
struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2<f32>, 3>( vec2<f32>(-1.0, -1.0), vec2<f32>( 3.0, -1.0), vec2<f32>(-1.0,  3.0) );
  var t = array<vec2<f32>, 3>( vec2<f32>(0.0, 0.0), vec2<f32>(2.0, 0.0), vec2<f32>(0.0, 2.0) );
  var o : VSOut; o.pos = vec4<f32>(p[vi], 0.0, 1.0); o.uv = t[vi]; return o;
}

@fragment
fn fs(i: VSOut) -> @location(0) vec4<f32> {
  let base = textureSample(videoTex, samp, i.uv).rgb;
  return vec4<f32>(base, 1.0);
}
