// fast_ball_detector.wgsl
// - Pass 1: seed_grid  -> pick best seed per team from a sparse grid (cheap dominance score)
// - Pass 2: refine_micro -> centroid inside a disk around each seed (very small area)
// Single-frame only. No temporal state.

// ────────────────────────────────────────────────────────────────────────────
// Bindings (group = 0)
//
// @binding(0) : sampler samp
// @binding(1) : texture_2d<f32> frame          // camera frame
//
// @binding(2) : storage BestA (seed for Team A)
// @binding(3) : storage BestB (seed for Team B)
//
// @binding(4) : storage StatsA (refined sums for Team A)
// @binding(5) : storage StatsB (refined sums for Team B)
//
// @binding(6) : uniform U                      // calibration + ROI
//
// (Optional) If you want a debug overlay later, add a storage texture and a
// simple fragment shader, but this core keeps things minimal & fast.
// ────────────────────────────────────────────────────────────────────────────

enable f16;

// ─────────────── Uniforms you asked to expose (and a few structural fields) ───────────────
struct Uniform {
  // ROI in pixel coords: [min, max)  (inclusive min, exclusive max)
  rMin         : vec2<u32>,
  rMax         : vec2<u32>,

  // Known ball radius (pixels). Grid stride derives from this.
  radiusPx     : f32,

  // Team color indices (0=R, 1=G, 2=B)
  colorA       : u32,
  colorB       : u32,

  // Thresholds you want to calibrate (per team)
  domThrA      : f32, // minimum dominance (e.g., 0.10..0.30)
  domThrB      : f32,
  yMinA        : f32, // minimum luma (0..1)
  yMinB        : f32,

  // Flags (bit0: A active, bit1: B active). If you don't need on/off, set 3 (both on).
  activeMask   : u32,

  // Reserved for alignment / future use
  _pad0        : vec3<u32>,
};

// ─────────────── Small storage buffers ───────────────

struct BestBuf {
  key : atomic<u32>,     // (scoreQ16<<16)|idx16  (so atomicMax prefers higher score, then tie-breaker)
  x   : atomic<u32>,     // seed pixel x
  y   : atomic<u32>,     // seed pixel y
};

struct Stats {
  cnt  : atomic<u32>,    // count of accepted pixels
  sumX : atomic<u32>,    // sum of x
  sumY : atomic<u32>,    // sum of y
};

@group(0) @binding(0) var samp  : sampler;
@group(0) @binding(1) var frame : texture_2d<f32>;

@group(0) @binding(2) var<storage, read_write> BestA  : BestBuf;
@group(0) @binding(3) var<storage, read_write> BestB  : BestBuf;

@group(0) @binding(4) var<storage, read_write> StatsA : Stats;
@group(0) @binding(5) var<storage, read_write> StatsB : Stats;

@group(0) @binding(6) var<uniform> U : Uniform;

// Preview bindings (match your original render bind group):
@group(0) @binding(4) var maskTex : texture_2d<f32>;                      // sampled in fs
@group(0) @binding(5) var samp2   : sampler;                              // render sampler
// Compute-side storage target to draw the preview mask (same image as maskTex)
@group(0) @binding(7) var maskOut : texture_storage_2d<rgba8unorm, write>;

// ─────────────── Helpers (mostly f16 math) ───────────────

fn clampToFrame(p: vec2<i32>) -> vec2<i32> {
  let d = vec2<i32>(textureDimensions(frame));  // cast u32 -> i32
  let x = clamp(p.x, 0, d.x - 1);
  let y = clamp(p.y, 0, d.y - 1);
  return vec2<i32>(x, y);
}

fn luma(rgb: vec3<f16>) -> f16 {
  // Rec. 601 weights; good enough and cheap
  return dot(rgb, vec3<f16>(0.299h, 0.587h, 0.114h));
}

fn sat_val(rgb: vec3<f16>) -> f16 {
  let mx = max(rgb.r, max(rgb.g, rgb.b));
  let mn = min(rgb.r, min(rgb.g, rgb.b));
  return mx - mn;
}

fn dom_color(rgb: vec3<f16>, colorIdx: u32) -> f16 {
  switch colorIdx {
    case 0u: { return rgb.r - max(rgb.g, rgb.b); }  // Red
    case 1u: { return rgb.g - max(rgb.r, rgb.b); }  // Green
    case 2u: { return rgb.b - max(rgb.r, rgb.g); }  // Blue
    case 3u: { return min(rgb.r, rgb.g) - rgb.b; }  // Yellow
    default: { return 0.0h; }
  }
}

// RGB preview color for index (0=R,1=G,2=B,3=Y)
fn color_from_index(idx: u32) -> vec3<f32> {
  switch idx {
    case 0u: { return vec3<f32>(1.0, 0.0, 0.0); } // red
    case 1u: { return vec3<f32>(0.0, 1.0, 0.0); } // green
    case 2u: { return vec3<f32>(0.0, 0.0, 1.0); } // blue
    case 3u: { return vec3<f32>(1.0, 1.0, 0.0); } // yellow
    default: { return vec3<f32>(1.0, 1.0, 1.0); }
  }
}

fn pack_key(score: f32, idx: u32) -> u32 {
  // Quantize score into Q16 in upper 16 bits (so higher score wins)
  let q : u32 = u32(clamp(score, 0.0, 1.0) * 65535.0 + 0.5);
  return (q << 16) | (idx & 0xFFFFu);
}

// 4-tap ring mean of dominance at +/-x, +/-y with integer radius (no trig)
fn ring_dom4(center: vec2<i32>, radius: i32, colorIdx: u32) -> f16 {
  let pR = clampToFrame(center + vec2<i32>( radius, 0));
  let pL = clampToFrame(center + vec2<i32>(-radius, 0));
  let pU = clampToFrame(center + vec2<i32>(0,  radius));
  let pD = clampToFrame(center + vec2<i32>(0, -radius));
  let rR = vec3<f16>(textureLoad(frame, pR, 0).rgb);
  let rL = vec3<f16>(textureLoad(frame, pL, 0).rgb);
  let rU = vec3<f16>(textureLoad(frame, pU, 0).rgb);
  let rD = vec3<f16>(textureLoad(frame, pD, 0).rgb);
  let d  = dom_color(rR, colorIdx) + dom_color(rL, colorIdx)
         + dom_color(rU, colorIdx) + dom_color(rD, colorIdx);
  return d * (1.0h / 4.0h);
}

// ─────────────── Pass 1: sparse grid seed (top-1 per team) ───────────────

@compute @workgroup_size(8, 8, 1)
fn seed_grid(
  @builtin(global_invocation_id) gid : vec3<u32>
) {
  let activeA = (U.activeMask & 1u) != 0u;
  let activeB = (U.activeMask & 2u) != 0u;

  let r0 = U.rMin;
  let r1 = U.rMax;
  let roi = r1 - r0;

  // Grid stride ≈ 2/3 * R, with clamp
  let R      = max(1.0, U.radiusPx);
  let S      = max(1u, u32(round(R * 0.6666667)));
  let gx     = gid.x;
  let gy     = gid.y;
  if (gx * S >= roi.x || gy * S >= roi.y) { return; }

  // Sample at the center of the grid cell
  let sx = r0.x + min(roi.x - 1u, gx * S + S / 2u);
  let sy = r0.y + min(roi.y - 1u, gy * S + S / 2u);
  let p  = vec2<i32>(i32(sx), i32(sy));

  // Cheap, robust cross-average (5 taps) to reduce single-pixel noise
  var sum : vec3<f16> = vec3<f16>(0.0h);
  {
    let c0 = vec3<f16>(textureLoad(frame, clampToFrame(p + vec2<i32>( 0, 0)), 0).rgb);
    let c1 = vec3<f16>(textureLoad(frame, clampToFrame(p + vec2<i32>( 1, 0)), 0).rgb);
    let c2 = vec3<f16>(textureLoad(frame, clampToFrame(p + vec2<i32>(-1, 0)), 0).rgb);
    let c3 = vec3<f16>(textureLoad(frame, clampToFrame(p + vec2<i32>( 0, 1)), 0).rgb);
    let c4 = vec3<f16>(textureLoad(frame, clampToFrame(p + vec2<i32>( 0,-1)), 0).rgb);
    sum = c0 + c1 + c2 + c3 + c4;
  }
  let rgb  = sum * (1.0h / 5.0h);
  let y    = luma(rgb);
  let sat  = sat_val(rgb);

  // Small hardcoded sat gate helps in poor light; tweak if you like.
  const SAT_MIN : f16 = 0.10h;

  // Compute scores for A/B (dominance − 4-tap ring mean), gated by luma/sat
  let dims = textureDimensions(frame);
  let idx  = u32(sy) * u32(dims.x) + u32(sx);
  let iR   = i32(max(1.0, U.radiusPx));

  if (activeA) {
    let domA   = dom_color(rgb, U.colorA);
    let scoreA = select(0.0h, domA - ring_dom4(p, iR, U.colorA),
                        (y >= f16(U.yMinA)) && (sat >= SAT_MIN) && (domA >= f16(U.domThrA)));
    if (scoreA > 0.0h) {
      let key  = pack_key(f32(clamp(scoreA, 0.0h, 1.0h)), idx);
      let prev = atomicMax(&BestA.key, key);
      if (key > prev) {
        atomicStore(&BestA.x, sx);
        atomicStore(&BestA.y, sy);
      }
    }
  }

  if (activeB) {
    let domB   = dom_color(rgb, U.colorB);
    let scoreB = select(0.0h, domB - ring_dom4(p, iR, U.colorB),
                        (y >= f16(U.yMinB)) && (sat >= SAT_MIN) && (domB >= f16(U.domThrB)));
    if (scoreB > 0.0h) {
      let key  = pack_key(f32(clamp(scoreB, 0.0h, 1.0h)), idx);
      let prev = atomicMax(&BestB.key, key);
      if (key > prev) {
        atomicStore(&BestB.x, sx);
        atomicStore(&BestB.y, sy);
      }
    }
  }
}

// ─────────────── Pass 2: micro-refine around seeds (disk, sparse sampling) ───────────────

fn aabb_intersects_disk(minP: vec2<f32>, maxP: vec2<f32>, c: vec2<f32>, r: f32) -> bool {
  // Clamp center to the AABB, then distance check
  let qx = clamp(c.x, minP.x, maxP.x);
  let qy = clamp(c.y, minP.y, maxP.y);
  let dx = c.x - qx;
  let dy = c.y - qy;
  return (dx*dx + dy*dy) <= (r*r);
}

// Workgroup accumulators for refine_micro (module scope)
var<workgroup> wgCntA  : atomic<u32>;
var<workgroup> wgSumXA : atomic<u32>;
var<workgroup> wgSumYA : atomic<u32>;
var<workgroup> wgCntB  : atomic<u32>;
var<workgroup> wgSumXB : atomic<u32>;
var<workgroup> wgSumYB : atomic<u32>;


@compute @workgroup_size(8, 8, 1)
fn refine_micro(
  @builtin(global_invocation_id) gid  : vec3<u32>,
  @builtin(local_invocation_id)  lid  : vec3<u32>,
  @builtin(workgroup_id)         wid  : vec3<u32>
) {
  let activeA = (U.activeMask & 1u) != 0u;
  let activeB = (U.activeMask & 2u) != 0u;
  if (!activeA && !activeB) { return; }

  let r0  = U.rMin;
  let r1  = U.rMax;
  let roi = r1 - r0;

  // Global pixel (we'll still early-out most threads)
  let gx = r0.x + gid.x;
  let gy = r0.y + gid.y;
  let inBounds   = (gid.x < roi.x) && (gid.y < roi.y);
  let sampleThis = (((gx ^ gy) & 1u) == 0u); // 50% subsample

  // Read seeds (if any)
  let hasA = atomicLoad(&BestA.key) != 0u;
  let hasB = atomicLoad(&BestB.key) != 0u;

  // Disk radii
  let R    = max(1.0, U.radiusPx);
  let Rr   = R * 1.5;                // refine radius = 1.5 * R (hardcoded; change if you like)
  let Rr2  = Rr * Rr;

  // Cull whole tiles (8x8 AABB vs disk). One check per workgroup.
  // Compute this group's AABB in pixel space:
  let tileMin = vec2<f32>(f32(r0.x + wid.x * 8u), f32(r0.y + wid.y * 8u));
  let tileMax = vec2<f32>(f32(min(r0.x + (wid.x + 1u) * 8u, r1.x)),
                          f32(min(r0.y + (wid.y + 1u) * 8u, r1.y)));

  var intersectsA = false;
  var intersectsB = false;
  if (hasA) {
    let cA = vec2<f32>(f32(atomicLoad(&BestA.x)) + 0.5, f32(atomicLoad(&BestA.y)) + 0.5);
    intersectsA = aabb_intersects_disk(tileMin, tileMax, cA, Rr);
  }
  if (hasB) {
    let cB = vec2<f32>(f32(atomicLoad(&BestB.x)) + 0.5, f32(atomicLoad(&BestB.y)) + 0.5);
    intersectsB = aabb_intersects_disk(tileMin, tileMax, cB, Rr);
  }
  let processA = activeA && hasA && intersectsA;
  let processB = activeB && hasB && intersectsB;

  if (all(lid.xy == vec2<u32>(0u, 0u))) {
    atomicStore(&wgCntA,  0u); atomicStore(&wgSumXA, 0u); atomicStore(&wgSumYA, 0u);
    atomicStore(&wgCntB,  0u); atomicStore(&wgSumXB, 0u); atomicStore(&wgSumYB, 0u);
  }
  workgroupBarrier();

  // Load pixel & gates once (only if needed); declare defaults so all lanes proceed to barriers
  var rgb : vec3<f16> = vec3<f16>(0.0h);
  var y   : f16       = 0.0h;
  if (inBounds && sampleThis && (processA || processB)) {
    let rgb32 = textureLoad(frame, vec2<i32>(i32(gx), i32(gy)), 0).rgb;
    rgb = vec3<f16>(rgb32);
    y   = luma(rgb);
  }

  // A
  if (processA && inBounds && sampleThis) {
    let cA = vec2<f32>(f32(atomicLoad(&BestA.x)) + 0.5, f32(atomicLoad(&BestA.y)) + 0.5);
    let dxA = f32(gx) - cA.x;
    let dyA = f32(gy) - cA.y;
    if (dxA*dxA + dyA*dyA <= Rr2) {
      let dA = dom_color(rgb, U.colorA);
      if ((y >= f16(U.yMinA)) && (dA >= f16(U.domThrA))) {
        atomicAdd(&wgCntA,  1u);
        atomicAdd(&wgSumXA, gx);
        atomicAdd(&wgSumYA, gy);
        let ca = color_from_index(U.colorA);
        textureStore(maskOut, vec2<i32>(i32(gx), i32(gy)), vec4<f32>(ca, 1.0));
      }
    }
  }

  // B
  if (processB && inBounds && sampleThis) {
    let cB = vec2<f32>(f32(atomicLoad(&BestB.x)) + 0.5, f32(atomicLoad(&BestB.y)) + 0.5);
    let dxB = f32(gx) - cB.x;
    let dyB = f32(gy) - cB.y;
    if (dxB*dxB + dyB*dyB <= Rr2) {
      let dB = dom_color(rgb, U.colorB);
      if ((y >= f16(U.yMinB)) && (dB >= f16(U.domThrB))) {
        atomicAdd(&wgCntB,  1u);
        atomicAdd(&wgSumXB, gx);
        atomicAdd(&wgSumYB, gy);
        let cb = color_from_index(U.colorB);
        textureStore(maskOut, vec2<i32>(i32(gx), i32(gy)), vec4<f32>(cb, 1.0));
      }
    }
  }

  workgroupBarrier();

  // One thread commits this tile's partial sums to global
  if (all(lid.xy == vec2<u32>(0u, 0u))) {
    let cA = atomicLoad(&wgCntA);
    if (cA > 0u) {
      atomicAdd(&StatsA.cnt,  cA);
      atomicAdd(&StatsA.sumX, atomicLoad(&wgSumXA));
      atomicAdd(&StatsA.sumY, atomicLoad(&wgSumYA));
    }
    let cB = atomicLoad(&wgCntB);
    if (cB > 0u) {
      atomicAdd(&StatsB.cnt,  cB);
      atomicAdd(&StatsB.sumX, atomicLoad(&wgSumXB));
      atomicAdd(&StatsB.sumY, atomicLoad(&wgSumYB));
    }
  }
}


// ─────────────── Fullscreen preview: video + mask overlay ───────────────
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
  );
  var uv = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(2.0, 1.0),
    vec2<f32>(0.0, -1.0)
  );
  var o: VSOut;
  o.pos = vec4<f32>(p[vi], 0.0, 1.0);
  o.uv  = uv[vi];
  return o;
}

@fragment
fn fs(i: VSOut) -> @location(0) vec4<f32> {
  // Sample video and mask; use the render sampler (samp2)
  let video = textureSample(frame,  samp2, i.uv).rgb;
  let mask  = textureSample(maskTex, samp2, i.uv).rgb;

  // Start with video + mask overlay
  let m = clamp(max(mask.r, max(mask.g, mask.b)), 0.0, 1.0);
  var outRgb = mix(video, mask, m * 0.6);

  // --------- Debug overlay: grid dots + detected centers ----------
  let dims   = vec2<f32>(textureDimensions(frame));
  let uv     = clamp(i.uv, vec2<f32>(0.0), vec2<f32>(1.0));
  let px     = uv * dims;                       // pixel coords in float
  let r0     = vec2<f32>(vec2<u32>(U.rMin));
  let r1     = vec2<f32>(vec2<u32>(U.rMax));
  let inROI  = all(px >= r0) && all(px < r1);

  // Grid stride ≈ 2/3 * R
  let S   = max(1.0, round(U.radiusPx * 0.6666667));
  let g0  = r0 + vec2<f32>(S * 0.5);            // first grid center in ROI
  let loc = px - g0;
  // modulo for floats
  let modx = loc.x - S * floor(loc.x / S);
  let mody = loc.y - S * floor(loc.y / S);
  let dx   = abs(modx - S * 0.5);
  let dy   = abs(mody - S * 0.5);
  let gdist= sqrt(dx*dx + dy*dy);
  // Small dot (~1px radius), faint grey
  let dotR = 1.0;
  let inROI_f : f32 = select(0.0, 1.0, inROI);
  let dotA = (1.0 - smoothstep(dotR, dotR + 1.0, gdist)) * inROI_f;

  // Detected center rings (small circle ~3px) in team colors, if seeds exist
  let hasA = atomicLoad(&BestA.key) != 0u;
  if (hasA) {
    let cA = vec2<f32>(f32(atomicLoad(&BestA.x)) + 0.5, f32(atomicLoad(&BestA.y)) + 0.5);
    let dA = distance(px, cA);
    let ringA = smoothstep(2.0, 3.0, dA) * (1.0 - smoothstep(3.0, 4.0, dA));
    outRgb = mix(outRgb, color_from_index(U.colorA), ringA);
  }
  let hasB = atomicLoad(&BestB.key) != 0u;
  if (hasB) {
    let cB = vec2<f32>(f32(atomicLoad(&BestB.x)) + 0.5, f32(atomicLoad(&BestB.y)) + 0.5);
    let dB = distance(px, cB);
    let ringB = smoothstep(2.0, 3.0, dB) * (1.0 - smoothstep(3.0, 4.0, dB));
    outRgb = mix(outRgb, color_from_index(U.colorB), ringB);
  }

  return vec4<f32>(outRgb, 1.0);
}