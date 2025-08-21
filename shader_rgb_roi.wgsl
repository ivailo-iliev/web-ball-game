
enable f16;

// ============================================================================
// Fast RGB ball detector with ROI-local outputs
// - Sparse grid + ring test (no HSV/YCbCr)
// - Tiny ROI centroid refinement
// - Detection happens ONLY inside ROI; outputs are ROI-space coordinates
// - Two-team support via running the compute twice (flags choose team A/B)
// ============================================================================

// --------------------------------------------------------------------
// Uniforms (group(0)@binding(6))
// --------------------------------------------------------------------
// Per team thresholds in RGB space:
//   TeamRGB {
//     minDom  : f32;   // required dominance of primary over others, exposure-invariant
//     yMin    : f32;   // luma floor
//     knee    : f32;   // softness (0.05..0.15 typical)
//     primary : f32;   // 0=R, 1=G, 2=B (stored as float for alignment)
//   }
// Other uniforms:
//   rMin/rMax : ROI rectangle in absolute texture pixel space (inclusive min, exclusive max)
//   flags     : bit0 PREVIEW, bit1 TEAM_A, bit2 TEAM_B
//   radius    : expected ball radius (pixels at working scale)
// --------------------------------------------------------------------

struct TeamRGB {
  minDom  : f32,
  yMin    : f32,
  knee    : f32,
  primary : f32, // 0,1,2 encoded in f32
};

struct Uniforms {
  A      : TeamRGB,
  B      : TeamRGB,

  rMin   : vec2<f32>,
  rMax   : vec2<f32>,

  flags  : u32,
  radius : f32,

  _pad0  : vec2<u32>,
};

@group(0) @binding(6) var<uniform> U : Uniforms;

// frame and preview mask
@group(0) @binding(0) var frameTex : texture_2d<f32>;
@group(0) @binding(1) var maskTex  : texture_storage_2d<rgba8unorm, write>;

// scratch for best candidate (one per run = per team)
struct BestBox { value : atomic<u32>, };
@group(0) @binding(2) var<storage, read_write> BestKey : BestBox;

// x, y, r, team (packed as u32s)
@group(0) @binding(3) var<storage, read_write> BestStats : array<u32>;

// final output for one run
struct OutRes {
  cx   : f32,  // ROI-local
  cy   : f32,  // ROI-local
  rad  : f32,  // ROI-local
  iq   : f32,
  mass : u32,
  ok   : u32,
};
@group(0) @binding(4) var<storage, read_write> Out : OutRes;

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

fn in_roi_abs(p: vec2<i32>) -> bool {
  // inclusive min, exclusive max
  return (f32(p.x) >= U.rMin.x) & (f32(p.y) >= U.rMin.y) &
         (f32(p.x) <  U.rMax.x) & (f32(p.y) <  U.rMax.y);
}

fn clamp_to_roi(p: vec2<f32>) -> vec2<f32> {
  return clamp(p, U.rMin, U.rMax - vec2<f32>(1.0));
}

fn luma(rgb: vec3<f32>) -> f32 {
  return 0.299*rgb.r + 0.587*rgb.g + 0.114*rgb.b;
}

// brightness-invariant dominance score in [0,1]
fn dom_score(rgb: vec3<f32>, T: TeamRGB) -> f32 {
  let y    = luma(rgb);
  let gate = select(0.0, 1.0, y >= T.yMin);
  let sum  = max(1e-3, rgb.r + rgb.g + rgb.b);

  let ip   = u32(round(T.primary)); // 0,1,2
  let prim = select(rgb.r, select(rgb.g, rgb.b, ip == 2u), ip == 1u);
  let oth1 = select(rgb.g, select(rgb.r, rgb.r, ip == 2u), ip == 1u);
  let oth2 = select(rgb.b, select(rgb.b, rgb.g, ip == 2u), ip == 1u);
  let mx   = max(oth1, oth2);

  let dom  = (prim - mx) / sum; // can be negative in background
  // soft knee around threshold
  let s = clamp((dom - T.minDom) / max(1e-3, T.knee), 0.0, 1.0);
  return s * gate;
}

fn sample_score_abs(p: vec2<i32>, T: TeamRGB) -> f32 {
  let rgb = textureLoad(frameTex, p, 0).rgb;
  return dom_score(rgb, T);
}

// 16 precomputed directions (unit circle)
const N_DIR : u32 = 16u;
const DIRS : array<vec2<f32>, 16> = array<vec2<f32>, 16>(
  vec2<f32>( 1.0000000,  0.0000000),
  vec2<f32>( 0.9238795,  0.3826834),
  vec2<f32>( 0.7071068,  0.7071068),
  vec2<f32>( 0.3826834,  0.9238795),
  vec2<f32>( 0.0000000,  1.0000000),
  vec2<f32>(-0.3826834,  0.9238795),
  vec2<f32>(-0.7071068,  0.7071068),
  vec2<f32>(-0.9238795,  0.3826834),
  vec2<f32>(-1.0000000,  0.0000000),
  vec2<f32>(-0.9238795, -0.3826834),
  vec2<f32>(-0.7071068, -0.7071068),
  vec2<f32>(-0.3826834, -0.9238795),
  vec2<f32>( 0.0000000, -1.0000000),
  vec2<f32>( 0.3826834, -0.9238795),
  vec2<f32>( 0.7071068, -0.7071068),
  vec2<f32>( 0.9238795, -0.3826834)
);

fn team_color(team: u32) -> vec4<f32> {
  let primary = select(U.A.primary, U.B.primary, team == 2u);
  let ip = u32(round(primary));
  let r = select(0.0, 1.0, ip == 0u);
  let g = select(0.0, 1.0, ip == 1u);
  let b = select(0.0, 1.0, ip == 2u);
  return vec4<f32>(r, g, b, 1.0);
}

fn mark_mask_abs(p: vec2<i32>, rgba: vec4<f32>) {
  if (!in_roi_abs(p)) { return; }
  textureStore(maskTex, p, rgba);
  textureStore(maskTex, p + vec2<i32>( 1, 0), rgba);
  textureStore(maskTex, p + vec2<i32>(-1, 0), rgba);
  textureStore(maskTex, p + vec2<i32>( 0, 1), rgba);
  textureStore(maskTex, p + vec2<i32>( 0,-1), rgba);
}

struct RingRes { inner:f32, mid:f32, outer:f32, valid:f32, nudge:vec2<f32>, };

// Evaluate rings but ONLY inside ROI; also compute a nudge toward center
fn ring_eval(seedAbs: vec2<i32>, T: TeamRGB, r: f32) -> RingRes {
  let R0 = 0.60 * r;
  let R1 = 1.00 * r;
  let R2 = 1.40 * r;

  var a0 = 0.0;
  var a1 = 0.0;
  var a2 = 0.0;
  var valid : f32 = 0.0;
  var nud : vec2<f32> = vec2<f32>(0.0);

  for (var i: u32 = 0u; i < N_DIR; i++) {
    let d = DIRS[i];
    let p0 = vec2<i32>(vec2<f32>(seedAbs) + d * R0);
    let p1 = vec2<i32>(vec2<f32>(seedAbs) + d * R1);
    let p2 = vec2<i32>(vec2<f32>(seedAbs) + d * R2);

    if (!in_roi_abs(p0) || !in_roi_abs(p1) || !in_roi_abs(p2)) {
      continue;
    }

    let s0 = sample_score_abs(p0, T);
    let s1 = sample_score_abs(p1, T);
    let s2 = sample_score_abs(p2, T);

    a0 += s0;
    a1 += s1;
    a2 += s2;
    valid += 1.0;

    nud += (s1 - s2) * d;
  }

  if (valid > 0.0) {
    a0 /= valid; a1 /= valid; a2 /= valid;
    nud = (r / valid) * nud;
  }

  return RingRes(a0, a1, a2, valid / f32(N_DIR), nud);
}

// --------------------------------------------------------------------
// PASS 1 — sparse grid + ring test, keep best (per run / per team)
// --------------------------------------------------------------------
@compute @workgroup_size(16, 16, 1)
fn pass1(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pAbs = vec2<i32>(gid.xy);

  // Only operate inside ROI
  if (!in_roi_abs(pAbs)) { return; }

  // grid spacing tied to expected radius
  let r   = max(2.0, U.radius);
  let s   = max(2, i32(round(1.27279 * r))); // ~0.9*sqrt(2)*r
  // align grid origin to ROI
  let cx  = i32(floor(U.rMin.x)) + s/2;
  let cy  = i32(floor(U.rMin.y)) + s/2;

  if (((pAbs.x - cx) % s) != 0 || ((pAbs.y - cy) % s) != 0) { return; }

  let activeA = (U.flags & 2u) != 0u;
  let activeB = (U.flags & 4u) != 0u;

  var bestQ : f32 = 0.0;
  var bestP : vec2<i32> = pAbs;
  var bestTeam : u32 = 0u;

  if (activeA) {
    var rr = ring_eval(pAbs, U.A, r);
    let p2 = vec2<i32>(clamp_to_roi(vec2<f32>(pAbs) + clamp(rr.nudge, vec2<f32>(-0.4*r), vec2<f32>(0.4*r))));
    rr = ring_eval(p2, U.A, r);
    let q = max(0.0, (rr.inner + rr.mid)*0.5 - rr.outer);
    if (rr.valid >= 0.6 && q > bestQ) { bestQ = q; bestP = p2; bestTeam = 1u; }
  }

  if (activeB) {
    var rr = ring_eval(pAbs, U.B, r);
    let p2 = vec2<i32>(clamp_to_roi(vec2<f32>(pAbs) + clamp(rr.nudge, vec2<f32>(-0.4*r), vec2<f32>(0.4*r))));
    rr = ring_eval(p2, U.B, r);
    let q = max(0.0, (rr.inner + rr.mid)*0.5 - rr.outer);
    if (rr.valid >= 0.6 && q > bestQ) { bestQ = q; bestP = p2; bestTeam = 2u; }
  }

  if (bestTeam == 0u) { return; }

  if ((U.flags & 1u) != 0u) { mark_mask_abs(bestP, team_color(bestTeam)); }

  let qScaled : u32 = u32(clamp(bestQ * 100000.0, 0.0, 4000000000.0));
  let prev = atomicMax(&BestKey.value, qScaled);
  if (qScaled > prev) {
    BestStats[0] = bitcast<u32>(f32(bestP.x));
    BestStats[1] = bitcast<u32>(f32(bestP.y));
    BestStats[2] = bitcast<u32>(r);
    BestStats[3] = bestTeam;
  }
}

// --------------------------------------------------------------------
@compute @workgroup_size(16, 16, 1)
fn pass2(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (any(gid.xy != vec2<u32>(0))) { return; }

  let team = BestStats[3];
  if (team == 0u) {
    Out.cx = 0.0; Out.cy = 0.0; Out.rad = 0.0; Out.iq = 0.0;
    Out.mass = 0u; Out.ok = 0u;
    return;
  }

  let seedAbs = vec2<f32>(bitcast<f32>(BestStats[0]), bitcast<f32>(BestStats[1]));
  let r       = bitcast<f32>(BestStats[2]);
  let cond = team == 2u;
  let T_minDom  = select(U.A.minDom,  U.B.minDom,  cond);
  let T_yMin    = select(U.A.yMin,    U.B.yMin,    cond);
  let T_knee    = select(U.A.knee,    U.B.knee,    cond);
  let T_primary = select(U.A.primary, U.B.primary, cond);
  let T : TeamRGB = TeamRGB(T_minDom, T_yMin, T_knee, T_primary);

  // integrate within a small window around the seed, clamped to ROI
  let R = max(2.0, floor(1.6 * r));
  let mi = vec2<i32>(floor(clamp_to_roi(seedAbs - vec2<f32>(R))));
  let ma = vec2<i32>(floor(clamp_to_roi(seedAbs + vec2<f32>(R))));

  var mass = 0.0;
  var sumX = 0.0;
  var sumY = 0.0;

  for (var y:i32 = mi.y; y <= ma.y; y++) {
    for (var x:i32 = mi.x; x <= ma.x; x++) {
      let s = sample_score_abs(vec2<i32>(x,y), T);
      mass += s;
      sumX += s * f32(x);
      sumY += s * f32(y);
    }
  }

  if (mass <= 1e-3) {
    Out.cx = 0.0; Out.cy = 0.0; Out.rad = 0.0; Out.iq = 0.0;
    Out.mass = 0u; Out.ok = 0u;
    return;
  }

  let cxAbs = sumX / mass;
  let cyAbs = sumY / mass;
  let rad   = sqrt(max(0.0, mass) / 3.14159265);

  // --- Map to ROI-local coords ---
  let cxROI = cxAbs - U.rMin.x;
  let cyROI = cyAbs - U.rMin.y;

  Out.cx = cxROI; Out.cy = cyROI;
  Out.rad = rad;  // already in pixel units; ROI-local pixels == image pixels
  Out.iq = mass;
  Out.mass = u32(mass);
  Out.ok = 1u;

  // preview ring drawn at ABS coords (so it overlays correctly)
  if ((U.flags & 1u) != 0u) {
    let col = team_color(team);
    let steps : i32 = 64;
    for (var i:i32=0; i<steps; i++) {
      let a = 6.2831853 * f32(i) / f32(steps);
      let d = vec2<f32>(cos(a), sin(a));
      let q = vec2<i32>(floor(clamp_to_roi(vec2<f32>(cxAbs, cyAbs) + d * r)));
      textureStore(maskTex, q, col);
    }
  }
}

// --------------------------------------------------------------------
// Simple fullscreen preview shader kept here for completeness
// (group/binding layout assumes sampler at 5, frame at 0, mask at 4
// if you use a separate render pass; adjust to your app as needed.)
// --------------------------------------------------------------------

struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, };

@group(0) @binding(0) var tFrame : texture_2d<f32>;
@group(0) @binding(4) var tMask  : texture_2d<f32>;
@group(0) @binding(5) var samp   : sampler;

@vertex
fn vs(@builtin(vertex_index) vid: u32) -> VSOut {
  var P = array<vec2<f32>,3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
  );
  var UV = array<vec2<f32>,3>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(2.0, 0.0),
    vec2<f32>(0.0, 2.0)
  );
  var o: VSOut;
  o.pos = vec4<f32>(P[vid], 0.0, 1.0);
  o.uv  = UV[vid];
  return o;
}

@fragment
fn fs(i: VSOut) -> @location(0) vec4<f32> {
  let c = textureSample(tFrame, samp, i.uv);
  let m = textureSample(tMask,  samp, i.uv).rgb;
  return clamp(c + vec4<f32>(m, 0.0), vec4<f32>(0.0), vec4<f32>(1.0));
}
