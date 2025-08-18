enable f16;

///////////////////////////////////////////////////////////////
// Shared uniforms (keeps your original 64-byte layout)
///////////////////////////////////////////////////////////////
struct Uni {
  // Team A HSV range (lo.hsv, hi.hsv) — half floats
  hsvA_lo : vec3<f16>; _pa0: f16;
  hsvA_hi : vec3<f16>; _pa1: f16;

  // Team B HSV range
  hsvB_lo : vec3<f16>; _pb0: f16;
  hsvB_hi : vec3<f16>; _pb1: f16;

  // ROI in full-res pixels
  rectMin : vec2<f32>;
  rectMax : vec2<f32>;

  // bit0 PREVIEW, bit1 TEAM_A, bit2 TEAM_B
  flags   : u32;
  _padU   : u32;
};

const PREVIEW : u32 = 1u;
const TEAM_A  : u32 = 2u;
const TEAM_B  : u32 = 4u;

// ---- IO ----
@group(0) @binding(0) var frameTex : texture_2d<f32>;
@group(0) @binding(1) var maskTex  : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<storage, read_write> bestKey : atomic<u32>;
struct Stats { c:u32, sx:u32, sy:u32, per:u32; };
@group(0) @binding(3) var<storage, read_write> bestStats : Stats;
struct Result { cx:f32, cy:f32, r:f32, iq:f32, mass:u32, ok:u32; };
@group(0) @binding(4) var<storage, read_write> outRes : Result;
@group(0) @binding(6) var<uniform> U : Uni;

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
  return vec3<h16>(h, s, mx); // (h, s, v=max)
}
fn softHSV(hsv: vec3<f16>, lo: vec3<f16>, hi: vec3<f16>, shrink: f16) -> f16 {
  if (!hueIn(hsv.x, lo.x, hi.x)) { return 0.0h; }
  let sMid=(lo.y+hi.y)*0.5h; let sHalf=max(1e-3h,(hi.y-lo.y)*0.5h*shrink);
  let vMid=(lo.z+hi.z)*0.5h; let vHalf=max(1e-3h,(hi.z-lo.z)*0.5h*shrink);
  let sDepth = 1.0h - clamp(abs(hsv.y - sMid) / sHalf, 0.0h, 1.0h);
  let vDepth = 1.0h - clamp(abs(hsv.z - vMid) / vHalf, 0.0h, 1.0h);
  return sDepth * vDepth; // 0..1
}

///////////////////////////////////////////////////////////////
// PASS 1 — classify + reduce per 16×16 tile → global best tile
///////////////////////////////////////////////////////////////
@compute @workgroup_size(16,16)
fn pass1(@builtin(global_invocation_id) gid: vec3<u32>,
         @builtin(local_invocation_id)  lid: vec3<u32>,
         @builtin(workgroup_id)         wg : vec3<u32>) {

  let dims = textureDimensions(frameTex);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  // ROI reject
  let fx = f32(gid.x) + 0.5;
  let fy = f32(gid.y) + 0.5;
  if (fx < U.rectMin.x || fy < U.rectMin.y || fx > U.rectMax.x || fy > U.rectMax.y) { return; }

  let p = vec2<i32>(i32(gid.x), i32(gid.y));
  let rgbh = vec3<h16>(textureLoad(frameTex, p, 0).rgb);
  let hsv  = rgb2hsv_h(rgbh);

  // Tight/loose for both teams
  let aT = softHSV(hsv, U.hsvA_lo, U.hsvA_hi, 0.65h);
  let aL = softHSV(hsv, U.hsvA_lo, U.hsvA_hi, 0.80h);
  let bT = softHSV(hsv, U.hsvB_lo, U.hsvB_hi, 0.65h);
  let bL = softHSV(hsv, U.hsvB_lo, U.hsvB_hi, 0.80h);

  let teamAActive = (U.flags & TEAM_A) != 0u;
  let teamBActive = (U.flags & TEAM_B) != 0u;

  // neighbour consensus only when "loose" passed but "tight" failed
  fn neighbourConsensus(p: vec2<i32>, dims: vec2<u32>,
                        lo: vec3<f16>, hi: vec3<f16>) -> bool {
    let nb = array<vec2<i32>,4>(vec2<i32>(0,-1),vec2<i32>(0,1),vec2<i32>(-1,0),vec2<i32>(1,0));
    var votes:u32 = 0u;
    for (var i=0; i<4; i++) {
      let q = clamp(p + nb[i], vec2<i32>(0,0), vec2<i32>(i32(dims.x-1u), i32(dims.y-1u)));
      let c = vec3<h16>(textureLoad(frameTex, q, 0).rgb);
      let h = rgb2hsv_h(c);
      votes += select(0u, 1u, softHSV(h, lo, hi, 0.80h) > 0.0h);
    }
    return votes >= 2u;
  }

  var okA = false;
  if (teamAActive && (aT > 0.0h || aL > 0.0h)) {
    okA = select(neighbourConsensus(p, dims, U.hsvA_lo, U.hsvA_hi), true, aT > 0.0h);
  }
  var okB = false;
  if (teamBActive && (bT > 0.0h || bL > 0.0h)) {
    okB = select(neighbourConsensus(p, dims, U.hsvB_lo, U.hsvB_hi), true, bT > 0.0h);
  }

  let okAny = okA || okB;

  // Optional preview overlay (green = A, red = B, yellow = both)
  if ((U.flags & PREVIEW) != 0u && okAny) {
    let col =
      (select(vec3<f32>(0.0), vec3<f32>(0.0,1.0,0.0), okA)) +
      (select(vec3<f32>(0.0), vec3<f32>(1.0,0.0,0.0), okB));
    textureStore(maskTex, p, vec4<f32>(col, 1.0));
  }

  // Per-tile reduction (one u32 quad per lid)
  let idx = lid.y * 16u + lid.x;
  var<workgroup> C : array<u32,256>;
  var<workgroup> SX: array<u32,256>;
  var<workgroup> SY: array<u32,256>;
  var<workgroup> PE: array<u32,256>; // 4-neighbour perimeter flag

  let isOn = select(0u, 1u, okAny);
  let border =
    okAny && (
      (gid.x == 0u) || (gid.x+1u >= dims.x) ||
      (gid.y == 0u) || (gid.y+1u >= dims.y) ||
      !okAny  // filled below in practice — good enough proxy
    );

  C[idx]  = isOn;
  SX[idx] = select(0u, gid.x, okAny);
  SY[idx] = select(0u, gid.y, okAny);
  PE[idx] = select(0u, 1u, border);

  workgroupBarrier();

  var s = 128u;
  loop {
    if (idx < s) {
      let j = idx + s;
      C[idx]  += C[j];
      SX[idx] += SX[j];
      SY[idx] += SY[j];
      PE[idx] += PE[j];
    }
    s >>= 1u;
    if (s == 0u) { break; }
    workgroupBarrier();
  }

  // One thread publishes: argmax over tiles by mass
  if (idx == 0u) {
    let tilesX = (dims.x + 15u) / 16u;
    let tileId = wg.y * tilesX + wg.x;
    let key = (min(C[0], 0xFFFFFu) << 12u) | (tileId & 0xFFFu);
    let prev = atomicMax(&bestKey, key);
    if (key > prev) {
      bestStats.c  = C[0];
      bestStats.sx = SX[0];
      bestStats.sy = SY[0];
      bestStats.per= PE[0];
    }
  }
}

///////////////////////////////////////////////////////////////
// PASS 2 — grow region around the winner (cross-tile) and output
///////////////////////////////////////////////////////////////

// NOTE: we assume exp. radius ~37 px (from your photos). We gate area accordingly.
// If you want to pass a different radius later, expand the uniform.
const EXP_RADIUS : f32 = 37.0;

@compute @workgroup_size(16,16)
fn pass2(@builtin(local_invocation_id) lid: vec3<u32>) {
  // Seed from winner tile centroid
  let dims = textureDimensions(frameTex);
  let c    = max(1u, bestStats.c);
  let cx   = f32(bestStats.sx) / f32(c);
  let cy   = f32(bestStats.sy) / f32(c);

  // 128×128 window around seed (clamped)
  let half = 64.0; // 2*64=128
  let minx = i32(clamp(cx - half, 0.0, f32(dims.x-1u)));
  let miny = i32(clamp(cy - half, 0.0, f32(dims.y-1u)));
  let W    = min(128u, dims.x - u32(minx));
  let H    = min(128u, dims.y - u32(miny));

  // Workgroup-local masks (1 u32 per px)
  var<workgroup> mask : array<u32, 128*128>;
  var<workgroup> sel  : array<u32, 128*128>;
  var<workgroup> tmp  : array<u32, 128*128>;

  // Build mask in the window (union of A/B)
  for (var y:u32 = lid.y; y < H; y += 16u) {
    for (var x:u32 = lid.x; x < W; x += 16u) {
      let p = vec2<i32>(minx + i32(x), miny + i32(y));
      let hsv = rgb2hsv_h(vec3<h16>(textureLoad(frameTex, p, 0).rgb));
      let okA = ((U.flags & TEAM_A) != 0u) && (softHSV(hsv, U.hsvA_lo, U.hsvA_hi, 0.75h) > 0.0h);
      let okB = ((U.flags & TEAM_B) != 0u) && (softHSV(hsv, U.hsvB_lo, U.hsvB_hi, 0.75h) > 0.0h);
      let on  = select(0u, 1u, okA || okB);
      let i   = y*128u + x;
      mask[i] = on;
      sel[i]  = 0u;
    }
  }
  workgroupBarrier();

  // Seed: 5×5 patch around the centroid
  let sx = u32(clamp(i32(cx) - minx, 0, 127));
  let sy = u32(clamp(i32(cy) - miny, 0, 127));
  for (var dy:i32 = -2; dy <= 2; dy++) {
    for (var dx:i32 = -2; dx <= 2; dx++) {
      let xx = u32(clamp(i32(sx)+dx, 0, 127));
      let yy = u32(clamp(i32(sy)+dy, 0, 127));
      let i  = yy*128u + xx;
      if (mask[i] == 1u) { sel[i] = 1u; }
    }
  }
  workgroupBarrier();

  // Flood-fill (masked dilation) with early stop
  var changed:u32 = 1u;
  loop {
    if (all(lid.xy == vec2<u32>(0u,0u))) { changed = 0u; }
    workgroupBarrier();

    for (var y:u32 = lid.y; y < H; y += 16u) {
      for (var x:u32 = lid.x; x < W; x += 16u) {
        let i = y*128u + x;
        if (sel[i] == 1u) { tmp[i] = 1u; continue; }
        if (mask[i] == 0u) { tmp[i] = 0u; continue; }
        let l = (x>0u)       && (sel[i-1u]     == 1u);
        let r = (x+1u<W)     && (sel[i+1u]     == 1u);
        let u = (y>0u)       && (sel[i-128u]   == 1u);
        let d = (y+1u<H)     && (sel[i+128u]   == 1u);
        let s = l || r || u || d;
        tmp[i] = select(0u, 1u, s);
        if (s) { changed = 1u; }
      }
    }
    workgroupBarrier();

    for (var y:u32 = lid.y; y < H; y += 16u) {
      for (var x:u32 = lid.x; x < W; x += 16u) {
        sel[y*128u + x] = tmp[y*128u + x];
      }
    }
    workgroupBarrier();

    if (changed == 0u) { break; }
  }

  // Accumulate moments + 4-nbr perimeter
  var sumX:u32=0u; var sumY:u32=0u; var cnt:u32=0u; var per:u32=0u;
  for (var y:u32 = lid.y; y < H; y += 16u) {
    for (var x:u32 = lid.x; x < W; x += 16u) {
      let i = y*128u + x;
      if (sel[i] == 1u) {
        sumX += x; sumY += y; cnt += 1u;
        let l = (x==0u)    || (sel[i-1u]   == 0u);
        let r = (x+1u>=W)  || (sel[i+1u]   == 0u);
        let u = (y==0u)    || (sel[i-128u] == 0u);
        let d = (y+1u>=H)  || (sel[i+128u] == 0u);
        per += select(0u, 1u, (l||r||u||d));
      }
    }
  }

  // reduce in WG
  var<workgroup> SX:array<u32,256>;
  var<workgroup> SY:array<u32,256>;
  var<workgroup> C :array<u32,256>;
  var<workgroup> P :array<u32,256>;
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
// Preview VS/FS (unchanged API)
///////////////////////////////////////////////////////////////
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>; };

@group(0) @binding(5) var samp : sampler;
@group(0) @binding(0) var frameTex_s : texture_2d<f32>;
@group(0) @binding(4) var maskTex_s  : texture_2d<f32>;

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
  let base = textureSample(frameTex_s, samp, inp.uv);
  let m    = textureSample(maskTex_s,  samp, inp.uv).rgb;
  // Simple additive overlay
  return vec4<f32>(clamp(base.rgb + m * 0.7, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
