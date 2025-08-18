// shader.wgsl — dual-team circle detection (known radius) + coverage + overlay
// Single frame. Detects up to 2 balls (team A + team B) simultaneously.
// Votes centers on a downscaled grid, one accumulator per team, then reduces to
// per-team maxima and computes angular coverage per team.
//
// GROUP 0 BINDINGS:
//  0: videoTex   : texture_2d<f32>
//  1: samp       : sampler
//  2: I          : uniform ImageInfo
//  3: U          : uniform Params
//  4: accumA     : storage array<atomic<u32>>      // detW*detH
//  5: partialsA  : storage array<Pair>             // nWGx*nWGy
//  6: outResA    : storage TeamResult
//  7: angleMaskA : storage array<u32>              // ceil(nAngles/32)
//  8: accumB     : storage array<atomic<u32>>
//  9: partialsB  : storage array<Pair>
// 10: outResB    : storage TeamResult
// 11: angleMaskB : storage array<u32>
//
// RENDER OVERLAY: draws both circles (A=green, B=red).
//
// Notes:
// - ROI is in *full-res pixels* (same as your original).
// - r0 is in *detection scale* pixels (det grid). radius written out in full-res px.
// - Color gating uses normalized-rgb prototypes per team, supplied via Params.
//
// ----------------------------------------------------------------

enable f16;

struct ImageInfo {
  fullW  : u32, fullH  : u32,
  detW   : u32, detH   : u32,
  downscale : u32, _padI : u32,
};

struct Params {
  // ROI in full-res pixels
  rectMin : vec2<f32>,
  rectMax : vec2<f32>,

  // detection config
  r0         : u32,         // radius at detection scale
  rDelta     : u32,         // ± vote tolerance
  nAngles    : u32,
  _pad0      : u32,

  gradThresh : f32,         // <=0 -> 0.14 default
  thrRatio   : f32,         // e.g., 0.30 -> keep top 70% angles
  confAccept : f32,         // (host uses these; shader keeps them for reference)
  coverageMin: f32,

  // team toggles
  activeA : u32,
  activeB : u32,
  _pad1   : vec2<u32>,

  // team color prototypes (normalized-rgb)
  teamA_nrgb : vec2<f32>,   // (r̂, ĝ)
  teamA_thr  : f32,         // distance threshold
  _pa        : f32,

  teamB_nrgb : vec2<f32>,
  teamB_thr  : f32,
  _pb        : f32,
};

struct Pair { value: u32, index: u32; };

struct TeamResult {
  cx      : f32,    // full-res px
  cy      : f32,
  radius  : f32,    // full-res px
  conf    : f32,    // votes / expected
  coverage: f32,    // fraction of supported angles
  votes   : u32,    // raw max votes at det scale
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

fn nrgb(c: vec3<f32>) -> vec2<f32> {
  let s = max(1e-4, c.r + c.g + c.b);
  return vec2<f32>(c.r / s, c.g / s);
}

fn detUV(ix: i32, iy: i32) -> vec2<f32> {
  // det grid coord -> UV on full frame
  let d = vec2<f32>(f32(I.detW), f32(I.detH));
  return (vec2<f32>(f32(ix), f32(iy)) + vec2<f32>(0.5)) / d;
}

fn sobel_at(ix: i32, iy: i32) -> vec3<f32> {
  // Sobel on det grid (sampling full-res)
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
  let mag = sqrt(gx*gx + gy*gy) + 1e-6;
  return vec3<f32>(gx, gy, mag);
}

fn insideROI_full(px: f32, py: f32) -> bool {
  return px >= U.rectMin.x && px < U.rectMax.x &&
         py >= U.rectMin.y && py < U.rectMax.y;
}

// ---------------- Pass 1: vote into A and B accumulators ----------------
@compute @workgroup_size(16,16)
fn vote_centers(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= I.detW || gid.y >= I.detH) { return; }
  let x = i32(gid.x), y = i32(gid.y);
  if (x <= 0 || y <= 0 || x >= i32(I.detW)-1 || y >= i32(I.detH)-1) { return; }

  // ROI gate in *full-res* pixels, mapping det coord -> full coord
  let scale = f32(I.downscale);
  let px = (f32(x) + 0.5) * scale;
  let py = (f32(y) + 0.5) * scale;
  if (!insideROI_full(px, py)) { return; }

  // Edge gate
  let G = sobel_at(x, y);
  let thr = select(U.gradThresh, 0.14, U.gradThresh <= 0.0);
  if (G.z < thr) { return; }

  // Color gate (normalized-rgb at det sample UV)
  let f = nrgb(textureSampleLevel(videoTex, samp, detUV(x, y), 0.0).rgb);
  let hitA = (U.activeA == 1u) && (distance(f, U.teamA_nrgb) < U.teamA_thr);
  let hitB = (U.activeB == 1u) && (distance(f, U.teamB_nrgb) < U.teamB_thr);
  if (!(hitA || hitB)) { return; }

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

// ---------------- Pass 2a/2b: argmax per team ----------------
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
  sMaxVal[lindex] = val;
  sMaxIdx[lindex] = idx;
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
  var v : u32 = 0u;
  var idx : u32 = 0u;
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
  sMaxVal[lindex] = val;
  sMaxIdx[lindex] = idx;
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
  var v : u32 = 0u;
  var idx : u32 = 0u;
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

// -------------- Pass 3A: coverage for team A --------------
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
      let dotn = (gx*dir.x + gy*dir.y) / (mag + 1e-6);
      if (abs(dotn) < 0.75) { continue; }
      if (mag > best) { best = mag; }
    }
    if (best > localMax) { localMax = best; }
  }

  sMaxVal[li] = bitcast<u32>(localMax);
  workgroupBarrier();
  var stride : u32 = 32u;
  loop {
    if (stride == 0u) { break; }
    if (li < stride) {
      let a = bitcast<f32>(sMaxVal[li]);
      let b = bitcast<f32>(sMaxVal[li + stride]);
      if (b > a) { sMaxVal[li] = bitcast<u32>(b); }
    }
    workgroupBarrier();
    stride = stride / 2u;
  }
  let maxResp = bitcast<f32>(sMaxVal[0]);
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
      let dotn = (gx*dir.x + gy*dir.y) / (mag + 1e-6);
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

  sMaxIdx[li] = countSupported;
  workgroupBarrier();
  var stride2 : u32 = 32u;
  loop {
    if (stride2 == 0u) { break; }
    if (li < stride2) { sMaxIdx[li] = sMaxIdx[li] + sMaxIdx[li + stride2]; }
    workgroupBarrier();
    stride2 = stride2 / 2u;
  }
  if (li == 0u) { outResA.coverage = f32(sMaxIdx[0]) / f32(nA); }
}

// -------------- Pass 3B: coverage for team B --------------
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
      let dotn = (gx*dir.x + gy*dir.y) / (mag + 1e-6);
      if (abs(dotn) < 0.75) { continue; }
      if (mag > best) { best = mag; }
    }
    if (best > localMax) { localMax = best; }
  }

  sMaxVal[li] = bitcast<u32>(localMax);
  workgroupBarrier();
  var stride : u32 = 32u;
  loop {
    if (stride == 0u) { break; }
    if (li < stride) {
      let a = bitcast<f32>(sMaxVal[li]);
      let b = bitcast<f32>(sMaxVal[li + stride]);
      if (b > a) { sMaxVal[li] = bitcast<u32>(b); }
    }
    workgroupBarrier();
    stride = stride / 2u;
  }
  let maxResp = bitcast<f32>(sMaxVal[0]);
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
      let dotn = (gx*dir.x + gy*dir.y) / (mag + 1e-6);
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

  sMaxIdx[li] = countSupported;
  workgroupBarrier();
  var stride2 : u32 = 32u;
  loop {
    if (stride2 == 0u) { break; }
    if (li < stride2) { sMaxIdx[li] = sMaxIdx[li] + sMaxIdx[li + stride2]; }
    workgroupBarrier();
    stride2 = stride2 / 2u;
  }
  if (li == 0u) { outResB.coverage = f32(sMaxIdx[0]) / f32(nA); }
}

// ---------------- Render overlay: show circles for A (green) and B (red) ----------------
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

  let p = i.uv * vec2<f32>(f32(I.fullW), f32(I.fullH));

  // Team A ring (green)
  let dA = abs(length(p - vec2<f32>(outResA.cx, outResA.cy)) - outResA.radius);
  let ringA = smoothstep(2.0, 0.5, dA);

  // Team B ring (red)
  let dB = abs(length(p - vec2<f32>(outResB.cx, outResB.cy)) - outResB.radius);
  let ringB = smoothstep(2.0, 0.5, dB);

  var color = base;
  color = mix(color, vec3<f32>(0.0,1.0,0.0), 0.8 * ringA);
  color = mix(color, vec3<f32>(1.0,0.0,0.0), 0.8 * ringB);
  return vec4<f32>(color, 1.0);
}
