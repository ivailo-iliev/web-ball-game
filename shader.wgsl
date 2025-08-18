enable f16;

///////////////////////////////////////////////////////////////
// Uniforms (keeps your 64-byte shape)
///////////////////////////////////////////////////////////////
struct Uni {
  // Team A HSV range
  hsvA_lo : vec3<f16>,
  pa0: f16,
  hsvA_hi : vec3<f16>,
  pa1: f16,

  // Team B HSV range
  hsvB_lo : vec3<f16>,
  pb0: f16,
  hsvB_hi : vec3<f16>,
  pb1: f16,

  // ROI in full-res pixels
  rectMin : vec2<f32>,
  rectMax : vec2<f32>,

  // bit0 PREVIEW, bit1 TEAM_A, bit2 TEAM_B
  flags   : u32,
  padU    : u32,
}

const PREVIEW : u32 = 1u;
const TEAM_A  : u32 = 2u;
const TEAM_B  : u32 = 4u;

  var<workgroup> C : array<u32,256>;
  var<workgroup> SX: array<u32,256>;
  var<workgroup> SY: array<u32,256>;
  var<workgroup> P :array<u32,256>;


///////////////////////////////////////////////////////////////
// Resources
///////////////////////////////////////////////////////////////
@group(0) @binding(0) var frameTex : texture_2d<f32>;
@group(0) @binding(1) var maskTex  : texture_storage_2d<rgba8unorm, write>;

@group(0) @binding(2) var<storage, read_write> bestKey   : atomic<u32>;
struct Stats { c:u32, sx:u32, sy:u32, per:u32 }
@group(0) @binding(3) var<storage, read_write> bestStats : Stats;

struct Result { cx:f32, cy:f32, r:f32, iq:f32, mass:u32, ok:u32 }
@group(0) @binding(4) var<storage, read_write> outRes    : Result;

@group(0) @binding(5) var samp : sampler;
@group(0) @binding(6) var<uniform> U : Uni;

// For the preview fragment: sample the mask via a *separate* binding
// (same underlying texture as binding(1), different view/usage).
@group(0) @binding(4) var maskSample : texture_2d<f32>;

///////////////////////////////////////////////////////////////
// Helpers (f16 math)
///////////////////////////////////////////////////////////////
fn hueIn(h: f16, lo: f16, hi: f16) -> bool {
  let hlo = fract(lo); let hhi = fract(hi);
  return select(h >= hlo || h <= hhi, h >= hlo && h <= hhi, hlo > hhi);
}
fn rgb2hsv_h(c: vec3<f16>) -> vec3<f16> {
  let r=c.x; let g=c.y; let b=c.z;
  let mx = max(r, max(g,b));
  let mn = min(r, min(g,b));
  let d  = mx - mn;
  var h:f16 = 0.0h;
  if (d > 0.0h) {
    if (mx == r) { h = fract(((g - b) / d) / 6.0h); }
    else if (mx == g) { h = ((b - r) / d) / 6.0h + 1.0h/3.0h; }
    else { h = ((r - g) / d) / 6.0h + 2.0h/3.0h; }
  }
  let s = select(0.0h, d / max(1e-4h, mx), mx > 0.0h);
  return vec3<f16>(h, s, mx); // (h,s,v=max)
}
fn softHSV(hsv: vec3<f16>, lo: vec3<f16>, hi: vec3<f16>, shrink: f16) -> f16 {
  // No early-outs: compute a gate mask and apply it.
  // Also enforce S/V floors via lo.y (sMin) and lo.z (vMin).
  let hueOK = hueIn(hsv.x, lo.x, hi.x);
  let sOK   = hsv.y >= lo.y;
  let vOK   = hsv.z >= lo.z;

  // tighten S and V so "inside" pixels score higher
  let sMid  = (lo.y + hi.y) * 0.5h;
  let sHalf = max(1e-3h, (hi.y - lo.y) * 0.5h * shrink);
  let vMid  = (lo.z + hi.z) * 0.5h;
  let vHalf = max(1e-3h, (hi.z - lo.z) * 0.5h * shrink);
  let sDepth = 1.0h - clamp(abs(hsv.y - sMid) / sHalf, 0.0h, 1.0h);
  let vDepth = 1.0h - clamp(abs(hsv.z - vMid) / vHalf, 0.0h, 1.0h);
  let gate  = select(0.0h, 1.0h, hueOK && sOK && vOK);
  return gate * sDepth * vDepth; // 0..1
}

// Out-of-line (top-level) neighbor consensus; WGSL forbids nested functions.
fn neighbourConsensus(p: vec2<i32>, dims: vec2<u32>, lo: vec3<f16>, hi: vec3<f16>) -> bool {
  let nb = array<vec2<i32>,4>(vec2<i32>(0,-1),vec2<i32>(0,1),vec2<i32>(-1,0),vec2<i32>(1,0));
  var votes:u32 = 0u;
  for (var i=0; i<4; i++) {
    let q = clamp(p + nb[i], vec2<i32>(0,0), vec2<i32>(i32(dims.x-1u), i32(dims.y-1u)));
    let c = vec3<f16>(textureLoad(frameTex, q, 0).rgb);
    let h = rgb2hsv_h(c);
    votes += select(0u, 1u, softHSV(h, lo, hi, 0.80h) > 0.0h);
  }
  return votes >= 2u;
}

///////////////////////////////////////////////////////////////
// PASS 1 — classify + per-tile reduce → global best tile
///////////////////////////////////////////////////////////////
@compute @workgroup_size(16,16)
fn pass1(@builtin(global_invocation_id) gid: vec3<u32>,
         @builtin(local_invocation_id)  lid: vec3<u32>,
         @builtin(workgroup_id)         wg : vec3<u32>) {

  let dims = textureDimensions(frameTex);
  let inBounds = (gid.x < dims.x) && (gid.y < dims.y);

  // ROI test (no early returns; keep control flow uniform up to barriers)
  let fx = f32(gid.x) + 0.5;
  let fy = f32(gid.y) + 0.5;
  let inROI = (fx >= U.rectMin.x) && (fy >= U.rectMin.y) && (fx <= U.rectMax.x) && (fy <= U.rectMax.y);
  let isActive = inBounds && inROI;

  let p = vec2<i32>(i32(gid.x), i32(gid.y));
  var hsv : vec3<f16> = vec3<f16>(0.0h, 0.0h, 0.0h);
  if (isActive) {
    hsv = rgb2hsv_h(vec3<f16>(textureLoad(frameTex, p, 0).rgb));
  }

  var aT : f16 = 0.0h;
  var aL : f16 = 0.0h;
  var bT : f16 = 0.0h;
  var bL : f16 = 0.0h;
  if (isActive) {
    aT = softHSV(hsv, U.hsvA_lo, U.hsvA_hi, 0.65h);
    aL = softHSV(hsv, U.hsvA_lo, U.hsvA_hi, 0.80h);
    bT = softHSV(hsv, U.hsvB_lo, U.hsvB_hi, 0.65h);
    bL = softHSV(hsv, U.hsvB_lo, U.hsvB_hi, 0.80h);
  }

  let teamAActive = (U.flags & TEAM_A) != 0u;
  let teamBActive = (U.flags & TEAM_B) != 0u;

  var okA = false;
  if (teamAActive && isActive && (aT > 0.0h || aL > 0.0h)) {
    okA = select(neighbourConsensus(p, dims, U.hsvA_lo, U.hsvA_hi), true, aT > 0.0h);
  }
  var okB = false;
  if (teamBActive && isActive && (bT > 0.0h || bL > 0.0h)) {
    okB = select(neighbourConsensus(p, dims, U.hsvB_lo, U.hsvB_hi), true, bT > 0.0h);
  }

  let okAny = okA || okB;

  // Optional preview (green=A, red=B, yellow=both)
  if ((U.flags & PREVIEW) != 0u && okAny && isActive) {
    let col =
      (select(vec3<f32>(0.0), vec3<f32>(0.0,1.0,0.0), okA)) +
      (select(vec3<f32>(0.0), vec3<f32>(1.0,0.0,0.0), okB));
    textureStore(maskTex, p, vec4<f32>(col, 1.0));
  }

  // Per-tile reduction
  let idx = lid.y * 16u + lid.x;

  let v = select(0u, 1u, okAny && isActive);
  C[idx]  = v;
  SX[idx] = select(0u, gid.x, okAny && isActive);
  SY[idx] = select(0u, gid.y, okAny && isActive);
  workgroupBarrier();

  var s = 128u;
  loop {
    if (idx < s) {
      let j = idx + s;
      C[idx]  += C[j];
      SX[idx] += SX[j];
      SY[idx] += SY[j];
    }
    s >>= 1u;
    if (s == 0u) { break; }
    workgroupBarrier();
  }

  if (idx == 0u) {
    let tilesX = (dims.x + 15u) / 16u;
    let tileId = wg.y * tilesX + wg.x;
    let key    = (min(C[0], 0xFFFFFu) << 12u) | (tileId & 0xFFFu);
    let prev   = atomicMax(&bestKey, key);
    if (key > prev) {
      bestStats.c  = C[0];
      bestStats.sx = SX[0];
      bestStats.sy = SY[0];
      bestStats.per= 0u; // not used in this variant
    }
  }
}

///////////////////////////////////////////////////////////////
// PASS 2 — disk sampling around winner, final center
///////////////////////////////////////////////////////////////

// Measured radius from your photos (px at 1280×720)
const EXP_RADIUS : f32 = 37.0;

@compute @workgroup_size(16,16)
fn pass2(@builtin(local_invocation_id) lid: vec3<u32>) {
  let dims = textureDimensions(frameTex);

  // Seed = centroid of winner tile
  let c    = max(1u, bestStats.c);
  let cx   = f32(bestStats.sx) / f32(c);
  let cy   = f32(bestStats.sy) / f32(c);

  // Scan a square around the seed (±ceil(1.25*R))
  let R      = EXP_RADIUS;
  let margin = ceil(1.25 * R);
  let minx   = i32(clamp(cx - margin, 0.0, f32(dims.x-1u)));
  let miny   = i32(clamp(cy - margin, 0.0, f32(dims.y-1u)));
  let maxx   = i32(clamp(cx + margin, 0.0, f32(dims.x-1u)));
  let maxy   = i32(clamp(cy + margin, 0.0, f32(dims.y-1u)));
  let W      = u32(maxx - minx + 1);
  let H      = u32(maxy - miny + 1);

  let R2     = R * R;

  // Accumulate over the disk (no large shared arrays)
  var sumX:u32 = 0u; var sumY:u32 = 0u; var cnt:u32 = 0u; var per:u32 = 0u;

  for (var y:u32 = lid.y; y < H; y += 16u) {
    for (var x:u32 = lid.x; x < W; x += 16u) {
      let gx = f32(minx) + f32(x);
      let gy = f32(miny) + f32(y);
      let dx = gx - cx;
      let dy = gy - cy;
      if (dx*dx + dy*dy > R2) { continue; } // outside disk

      let p   = vec2<i32>(i32(gx), i32(gy));
      let hsv = rgb2hsv_h(vec3<f16>(textureLoad(frameTex, p, 0).rgb));
      let aOK = ((U.flags & TEAM_A) != 0u) && (softHSV(hsv, U.hsvA_lo, U.hsvA_hi, 0.75h) > 0.0h);
      let bOK = ((U.flags & TEAM_B) != 0u) && (softHSV(hsv, U.hsvB_lo, U.hsvB_hi, 0.75h) > 0.0h);
      let on  = aOK || bOK;
      if (!on) { continue; }

      sumX += x; sumY += y; cnt += 1u;

      // perimeter (approx): if any 4-nbr inside disk fails color check
      var edge = false;
      if (x > 0u) {
        let q = vec2<i32>(i32(gx-1.0), i32(gy));
        let hsvq = rgb2hsv_h(vec3<f16>(textureLoad(frameTex, q, 0).rgb));
        let okq  = (((U.flags & TEAM_A)!=0u) && (softHSV(hsvq, U.hsvA_lo, U.hsvA_hi, 0.75h)>0.0h)) ||
                   (((U.flags & TEAM_B)!=0u) && (softHSV(hsvq, U.hsvB_lo, U.hsvB_hi, 0.75h)>0.0h));
        edge = edge || (!okq);
      }
      if (x+1u < W) {
        let q = vec2<i32>(i32(gx+1.0), i32(gy));
        let hsvq = rgb2hsv_h(vec3<f16>(textureLoad(frameTex, q, 0).rgb));
        let okq  = (((U.flags & TEAM_A)!=0u) && (softHSV(hsvq, U.hsvA_lo, U.hsvA_hi, 0.75h)>0.0h)) ||
                   (((U.flags & TEAM_B)!=0u) && (softHSV(hsvq, U.hsvB_lo, U.hsvB_hi, 0.75h)>0.0h));
        edge = edge || (!okq);
      }
      if (y > 0u) {
        let q = vec2<i32>(i32(gx), i32(gy-1.0));
        let hsvq = rgb2hsv_h(vec3<f16>(textureLoad(frameTex, q, 0).rgb));
        let okq  = (((U.flags & TEAM_A)!=0u) && (softHSV(hsvq, U.hsvA_lo, U.hsvA_hi, 0.75h)>0.0h)) ||
                   (((U.flags & TEAM_B)!=0u) && (softHSV(hsvq, U.hsvB_lo, U.hsvB_hi, 0.75h)>0.0h));
        edge = edge || (!okq);
      }
      if (y+1u < H) {
        let q = vec2<i32>(i32(gx), i32(gy+1.0));
        let hsvq = rgb2hsv_h(vec3<f16>(textureLoad(frameTex, q, 0).rgb));
        let okq  = (((U.flags & TEAM_A)!=0u) && (softHSV(hsvq, U.hsvA_lo, U.hsvA_hi, 0.75h)>0.0h)) ||
                   (((U.flags & TEAM_B)!=0u) && (softHSV(hsvq, U.hsvB_lo, U.hsvB_hi, 0.75h)>0.0h));
        edge = edge || (!okq);
      }
      if (edge) { per += 1u; }
    }
  }

  // Reduce within workgroup
  let id = lid.y*16u + lid.x;
  SX[id]=sumX; SY[id]=sumY; C[id]=cnt; P[id]=per;
  workgroupBarrier();

  var step=128u;
  loop {
    if (id < step) { let j=id+step; SX[id]+=SX[j]; SY[id]+=SY[j]; C[id]+=C[j]; P[id]+=P[j]; }
    step >>= 1u; if (step == 0u) { break; }
    workgroupBarrier();
  }

  if (id == 0u) {
    let mass  = max(1u, C[0]);
    let cxLoc = f32(SX[0]) / f32(mass);
    let cyLoc = f32(SY[0]) / f32(mass);

    let cxFull = f32(minx) + cxLoc;
    let cyFull = f32(miny) + cyLoc;

    let area = f32(mass);
    let rEst = sqrt(area / 3.14159265);
    let iq   = (4.0*3.14159265*area) / max(1.0, f32(P[0])*f32(P[0]));

    // in-shader accept using measured radius ≈37 px
    let Amin = 0.35 * 3.14159265 * EXP_RADIUS * EXP_RADIUS;
    let Amax = 1.80 * 3.14159265 * EXP_RADIUS * EXP_RADIUS;
    let ok   = select(0u, 1u, (area >= Amin && area <= Amax && iq >= 0.55));

    outRes = Result(cxFull, cyFull, rEst, iq, mass, ok);
  }
}

///////////////////////////////////////////////////////////////
// Preview VS/FS
///////////////////////////////////////////////////////////////
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> }

@vertex
fn vs(@builtin(vertex_index) vid: u32) -> VSOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
  );
  var o: VSOut;
  o.pos = vec4<f32>(p[vid], 0.0, 1.0);
  o.uv  = 0.5 * (p[vid] + vec2<f32>(1.0, 1.0));
  return o;
}

@fragment
fn fs(inp: VSOut) -> @location(0) vec4<f32> {
  let base = textureSample(frameTex,  samp, inp.uv);
  let m    = textureSample(maskSample, samp, inp.uv).rgb;
  return vec4<f32>(clamp(base.rgb + m * 0.7, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
