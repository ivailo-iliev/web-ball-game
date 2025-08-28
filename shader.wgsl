// fast_ball_detector.wgsl
// - Pass 1: seed_grid  -> pick best seed per team from a sparse grid (cheap dominance score)
// - Pass 2: refine_micro -> centroid inside a disk around each seed (very small area)
// Single-frame only. No temporal state.

// ────────────────────────────────────────────────────────────────────────────
// Bindings (group = 0)
//
// @binding(1) : texture_2d<f32> frame          // camera frame (create as rgba8unorm-srgb; textureLoad gives linear)
//
// @binding(2) : storage BestA (seed for Team A)
// @binding(3) : storage BestB (seed for Team B)
//
// @binding(4) : storage StatsA (refined sums for Team A)
// @binding(5) : storage StatsB (refined sums for Team B)
//
// @binding(6) : uniform U                      // ROI + single knob + per-team gates
// @binding(8) : storage Grid (one atomic counter used to finalize inside refine)
//
// (Optional) If you want a debug overlay later, add a storage texture and a
// simple fragment shader, but this core keeps things minimal & fast.
// ────────────────────────────────────────────────────────────────────────────

enable f16;

// ─────────────── Uniforms (64 bytes) ───────────────
struct Uniform {
  // ROI
  rMin         : vec2<u32>,   //  0
  rMax         : vec2<u32>,   //  8

  // Scale + color ids
  radiusPx     : f32,         // 16  (single knob; stride & refine derive from this)
  colorA       : u32,         // 20  (0=R,1=G,2=B,3=Y)
  colorB       : u32,         // 24

  // Per-team gates (same logic for both “impact” and “coordinate” use)
  domThrA      : f32,         // 28
  satMinA      : f32,         // 32
  yMinA        : f32,         // 36
  yMaxA        : f32,         // 40

  domThrB      : f32,         // 44
  satMinB      : f32,         // 48
  yMinB        : f32,         // 52
  yMaxB        : f32,         // 56

  activeMask   : u32,         // 60  (bit0=A, bit1=B)
}

// ─────────────── Small storage buffers ───────────────

struct BestBuf {
  key : atomic<u32>,     // (scoreQ16<<16)|idx16  (so atomicMax prefers higher score, then tie-breaker)
  x   : atomic<u32>,     // seed pixel x
  y   : atomic<u32>,     // seed pixel y
}

struct Stats {
  cnt  : atomic<u32>,    // count of accepted pixels
  sumX : atomic<u32>,    // sum of x
  sumY : atomic<u32>,    // sum of y
}

// Single uint counter: number of completed tiles in refine
struct GridSync {
  done : atomic<u32>,
}

@group(0) @binding(1) var frame : texture_2d<f32>;

@group(0) @binding(2) var<storage, read_write> BestA  : BestBuf;
@group(0) @binding(3) var<storage, read_write> BestB  : BestBuf;

@group(0) @binding(4) var<storage, read_write> StatsA : Stats;
@group(0) @binding(5) var<storage, read_write> StatsB : Stats;

@group(0) @binding(6) var<uniform> U : Uniform;
@group(0) @binding(8) var<storage, read_write> Grid : GridSync;

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

// Normalized dominance (brightness-invariant) with small epsilon
fn dom_norm(rgb: vec3<f16>, colorIdx: u32) -> f16 {
  const EPS: f16 = 0.001h;
  let sum = rgb.r + rgb.g + rgb.b + EPS;
  var d: f16 = 0.0h;
  switch colorIdx {
    case 0u: { d = rgb.r - max(rgb.g, rgb.b); }         // Red
    case 1u: { d = rgb.g - max(rgb.r, rgb.b); }         // Green
    case 2u: { d = rgb.b - max(rgb.r, rgb.g); }         // Blue
    case 3u: { d = min(rgb.r, rgb.g) - rgb.b; }         // Yellow
    default: { d = 0.0h; }
  }
  return d / sum;
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

// Load a pixel in linear space (frame texture is created as -srgb)
fn texelLinearAt(pi: vec2<i32>) -> vec3<f16> {
  let p = clampToFrame(pi);
  let rgb32 = textureLoad(frame, p, 0).rgb;
  return vec3<f16>(rgb32);
}

// 5-tap cross average around pixel center
fn cross5_rgb(p: vec2<i32>) -> vec3<f16> {
  let c0 = texelLinearAt(p + vec2<i32>( 0, 0));
  let c1 = texelLinearAt(p + vec2<i32>( 1, 0));
  let c2 = texelLinearAt(p + vec2<i32>(-1, 0));
  let c3 = texelLinearAt(p + vec2<i32>( 0, 1));
  let c4 = texelLinearAt(p + vec2<i32>( 0,-1));
  return (c0 + c1 + c2 + c3 + c4) * (1.0h / 5.0h);
}

// 4-tap ring mean of *normalized dominance* at +/-x, +/-y with integer radius (no trig)
fn ring_dom4_norm(center: vec2<i32>, radius: i32, colorIdx: u32) -> f16 {
  let pR = center + vec2<i32>( radius, 0);
  let pL = center + vec2<i32>(-radius, 0);
  let pU = center + vec2<i32>(0,  radius);
  let pD = center + vec2<i32>(0, -radius);
  let rR = texelLinearAt(pR);
  let rL = texelLinearAt(pL);
  let rU = texelLinearAt(pU);
  let rD = texelLinearAt(pD);
  let d  = dom_norm(rR, colorIdx) + dom_norm(rL, colorIdx)
         + dom_norm(rU, colorIdx) + dom_norm(rD, colorIdx);
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

  // Grid stride ≈ 2/3 * R
  let R      = max(1.0, U.radiusPx);
  let S      = max(1u, u32(round(R * 0.6666667)));
  let iR     = i32(clamp(S, 4u, 16u)); // ring distance for local-contrast
  let gx     = gid.x;
  let gy     = gid.y;
  if (gx * S >= roi.x || gy * S >= roi.y) { return; }

  // Sample at the center of the grid cell
  let sx = r0.x + min(roi.x - 1u, gx * S + S / 2u);
  let sy = r0.y + min(roi.y - 1u, gy * S + S / 2u);
  let p  = vec2<i32>(i32(sx), i32(sy));

  // 5-tap cross average in linear RGB
  let rgb  = cross5_rgb(p);
  let y    = luma(rgb);
  let sat  = sat_val(rgb);

  // Seed score threshold (local-contrast). 0.02–0.03 works well.
  const SEED_CTHR : f16 = 0.025h; // default

  // Compute scores for A/B (normalized dominance − 4-tap ring mean), gated by sat + luma window
  let dims = textureDimensions(frame);
  let idx  = u32(sy) * u32(dims.x) + u32(sx);

  if (activeA) {
    let domA   = dom_norm(rgb, U.colorA);
    let passA  = (sat >= f16(U.satMinA)) &&
                 (domA >= f16(U.domThrA)) &&
                 (y >= f16(U.yMinA)) && (y <= f16(U.yMaxA));
    let scoreA = select(0.0h, domA - ring_dom4_norm(p, iR, U.colorA), passA);
    if (scoreA >= SEED_CTHR) {
      // tiny preview mark at the sample
      textureStore(maskOut, vec2<i32>(i32(sx), i32(sy)), vec4<f32>(color_from_index(U.colorA), 1.0));
      let key  = pack_key(f32(clamp(scoreA, 0.0h, 1.0h)), idx);
      let prev = atomicMax(&BestA.key, key);
      if (key > prev) {
        atomicStore(&BestA.x, sx);
        atomicStore(&BestA.y, sy);
      }
    }
  }

  if (activeB) {
    let domB   = dom_norm(rgb, U.colorB);
    let passB  = (sat >= f16(U.satMinB)) &&
                 (domB >= f16(U.domThrB)) &&
                 (y >= f16(U.yMinB)) && (y <= f16(U.yMaxB));
    let scoreB = select(0.0h, domB - ring_dom4_norm(p, iR, U.colorB), passB);
    if (scoreB >= SEED_CTHR) {
      textureStore(maskOut, vec2<i32>(i32(sx), i32(sy)), vec4<f32>(color_from_index(U.colorB), 1.0));
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
  var sat : f16       = 0.0h;
  if (inBounds && sampleThis && (processA || processB)) {
    rgb = texelLinearAt(vec2<i32>(i32(gx), i32(gy)));
    y   = luma(rgb);
    sat = sat_val(rgb);
  }

  // A
  if (processA && inBounds && sampleThis) {
    let cA = vec2<f32>(f32(atomicLoad(&BestA.x)) + 0.5, f32(atomicLoad(&BestA.y)) + 0.5);
    let dxA = f32(gx) - cA.x;
    let dyA = f32(gy) - cA.y;
    if (dxA*dxA + dyA*dyA <= Rr2) {
      let dA = dom_norm(rgb, U.colorA);
      if ((sat >= f16(U.satMinA)) && (dA >= f16(U.domThrA)) && (y >= f16(U.yMinA)) && (y <= f16(U.yMaxA))) {
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
      let dB = dom_norm(rgb, U.colorB);
      if ((sat >= f16(U.satMinB)) && (dB >= f16(U.domThrB)) && (y >= f16(U.yMinB)) && (y <= f16(U.yMaxB))) {
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

    // ── Grid completion + on-the-spot finalize (no extra pass) ──
    // Compute total tiles this dispatch should cover (ceil(roi/8))
    let tilesX = (roi.x + 7u) / 8u;
    let tilesY = (roi.y + 7u) / 8u;
    let total  = tilesX * tilesY;
    // Mark this tile done; the *last* tile performs the centroid division.
    let prev = atomicAdd(&Grid.done, 1u);
    if (prev + 1u == total) {
      // A
      let cntA2 = atomicLoad(&StatsA.cnt);
      if (cntA2 > 0u) {
        let sxA = atomicLoad(&StatsA.sumX);
        let syA = atomicLoad(&StatsA.sumY);
        let xA  = (sxA + cntA2 / 2u) / cntA2; // rounded integer centroid
        let yA  = (syA + cntA2 / 2u) / cntA2;
        atomicStore(&BestA.x, xA);
        atomicStore(&BestA.y, yA);
      }
      // B
      let cntB2 = atomicLoad(&StatsB.cnt);
      if (cntB2 > 0u) {
        let sxB = atomicLoad(&StatsB.sumX);
        let syB = atomicLoad(&StatsB.sumY);
        let xB  = (sxB + cntB2 / 2u) / cntB2;
        let yB  = (syB + cntB2 / 2u) / cntB2;
        atomicStore(&BestB.x, xB);
        atomicStore(&BestB.y, yB);
      }
      // (Optional) clear Grid.done here; recommended to clear in JS before dispatch instead.
    }
  }
}

// ─────────────── Fullscreen preview: video + mask overlay ───────────────
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, }

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
  // Base video
  let video = textureSample(frame, samp2, i.uv).rgb;
  var outRgb = video;

  // Coords / ROI
  let dims  = vec2<u32>(textureDimensions(frame));
  let dimsF = vec2<f32>(dims);
  let uv    = clamp(i.uv, vec2<f32>(0.0), vec2<f32>(1.0));
  let px    = uv * dimsF;

  let r0u = vec2<u32>(U.rMin);
  let r1u = vec2<u32>(U.rMax);
  let r0  = vec2<f32>(r0u);
  let r1  = vec2<f32>(r1u);
  let inROI = all(px >= r0) && all(px < r1);

  // Grid layout (match compute)
  let S_u = max(1u, u32(round(U.radiusPx * 0.6666667)));
  let S_f = f32(S_u);
  let g0i = vec2<i32>(r0u) + vec2<i32>(i32(S_u / 2u));
  let g0f = vec2<f32>(g0i);

  // Nearest grid center to this fragment
  let loc = px - g0f;
  let nx  = i32(round(loc.x / S_f));
  let ny  = i32(round(loc.y / S_f));
  let gcF = g0f + vec2<f32>(f32(nx) * S_f, f32(ny) * S_f);
  let gcI = g0i + vec2<i32>(nx * i32(S_u), ny * i32(S_u));

  // Sample mask color at the EXACT grid center pixel
  let dimsI = vec2<i32>(i32(dims.x), i32(dims.y));
  let gcClamped = vec2<i32>(
    clamp(gcI.x, 0, dimsI.x - 1),
    clamp(gcI.y, 0, dimsI.y - 1)
  );
  let maskC = textureLoad(maskTex, gcClamped, 0).rgb;
  let hit   = clamp(max(maskC.r, max(maskC.g, maskC.b)), 0.0, 1.0);

  // ---- ALL passing grid dots, as SOLID color (overwrite) ----
  let DOT_R : f32 = 1.5; // tweak as you like
  let dotInside = (distance(px, gcF) <= DOT_R);
  let showDot = inROI && (hit >= 0.5) && dotInside;
  if (showDot) {
    outRgb = maskC; // solid dot tint = detected color
  }

  // ---- ONLY the best refined center per color, as SOLID disks ----
  let CENTER_R : f32 = 3.0; // tweak as you like

  let hasA = atomicLoad(&BestA.key) != 0u;
  if (hasA) {
    let cA = vec2<f32>(f32(atomicLoad(&BestA.x)) + 0.5, f32(atomicLoad(&BestA.y)) + 0.5);
    if (distance(px, cA) <= CENTER_R) {
      outRgb = color_from_index(U.colorA); // solid center A
    }
  }

  let hasB = atomicLoad(&BestB.key) != 0u;
  if (hasB) {
    let cB = vec2<f32>(f32(atomicLoad(&BestB.x)) + 0.5, f32(atomicLoad(&BestB.y)) + 0.5);
    if (distance(px, cB) <= CENTER_R) {
      outRgb = color_from_index(U.colorB); // solid center B
    }
  }

  return vec4<f32>(outRgb, 1.0);
}
