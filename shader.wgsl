// shader.wgsl – unified compute & render module

// ------------- Bindings (group 0) -------------

enable f16;
/* 64-byte uniform:
 *  0–15 : hsvA  (lo+hi)
 * 16–31 : hsvB  (lo+hi)
 * 32–39 : rectMin (vec2<f32>)
 * 40–47 : rectMax (vec2<f32>)
 * 48–63 : flags   (vec4<u32>)
 */
struct Uniform {
    hsvA_lo : vec3<f16>, _0 : f16,
    hsvA_hi : vec3<f16>, _1 : f16,
    hsvB_lo : vec3<f16>, _2 : f16,
    hsvB_hi : vec3<f16>, _3 : f16,
    rectMin : vec2<f32>,
    rectMax : vec2<f32>,
    flags   : vec4<u32>,
 };

struct Stats {
    cnt  : atomic<u32>,
    sumX : atomic<u32>,
    sumY : atomic<u32>,
};

@group(0) @binding(0) var frame    : texture_2d<f32>;
@group(0) @binding(1) var dstTex   : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<storage, read_write> statsA : Stats;
@group(0) @binding(3) var<storage, read_write> statsB : Stats;
@group(0) @binding(4) var maskTex : texture_2d<f32>;      // **untouched**
@group(0) @binding(5) var samp    : sampler;               // **untouched**
@group(0) @binding(6) var<uniform> U        : Uniform;     // **moved to 6**

// ----------------------------------------------
// Helper: RGB → HSV (all in [0,1], GLSL-style)

fn rgb2hsv(c: vec3<f16>) -> vec3<f16> {
    let K = vec4<f16>(0.0, -1.0/3.0, 2.0/3.0, -1.0);
    let p = select(
        vec4<f16>(c.bg, K.wz),
        vec4<f16>(c.gb, K.xy),
        vec4<bool>(c.b < c.g, c.b < c.g, c.b < c.g, c.b < c.g)
    );
    let q = select(
        vec4<f16>(p.xyw, c.r),
        vec4<f16>(c.r, p.yzx),
        vec4<bool>(p.x < c.r, p.x < c.r, p.x < c.r, p.x < c.r)
    );
    let d = q.x - min(q.w, q.y);
    let e: f16 = 1e-3h;
    let h = fract(q.z + (q.w - q.y) / (6.0h * d + e));
    let s = d / (q.x + e);
    let v = q.x;
    return vec3<f16>(h, s, v);
}

fn inA(h: vec3<f16>) -> bool {
    return all(h >= U.hsvA_lo) && all(h <= U.hsvA_hi);
}
fn inB(h: vec3<f16>) -> bool {
    return all(h >= U.hsvB_lo) && all(h <= U.hsvB_hi);
}

// Point-in-polygon with even-odd rule
fn insideRect(p: vec2<f32>) -> bool {
    return  p.x >= U.rectMin.x && p.x < U.rectMax.x &&
            p.y >= U.rectMin.y && p.y < U.rectMax.y;
}

// ----------------------------------------------
// Compute pass: detect colour blobs & write mask

@compute @workgroup_size(8,32)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let fx = f32(global_id.x);
    let fy = f32(global_id.y);

    if (!insideRect(vec2<f32>(fx, fy))) {
        return;
    }

    /* --- decode the 3 flag bits packed in U.flags.x --- */
    let previewOn   = (U.flags.x & 1u) != 0u;
    let teamAActive = (U.flags.x & 2u) != 0u;
    let teamBActive = (U.flags.x & 4u) != 0u;
    if (!teamAActive && !teamBActive) {
        /* nothing to test this pixel */
        return;
    }

    // 2) Sample pixel, convert to HSV
    let rgb = textureLoad(frame,  vec2<i32>(i32(global_id.x), i32(global_id.y)), 0).rgb;
    let hsv = rgb2hsv(vec3<f16>(rgb));

    // 3) If in range, increment stats & optionally store mask
    var hitA = false;
    if (teamAActive && inA(hsv)) {
        hitA = true;
        atomicAdd(&statsA.cnt , 1u);
        atomicAdd(&statsA.sumX, global_id.x);
        atomicAdd(&statsA.sumY, global_id.y);
        // draw A-mask when preview is on
        if (previewOn) {
            textureStore(dstTex,
                vec2<i32>(i32(global_id.x), i32(global_id.y)),
                vec4<f32>(1.0, 0.0, 0.0, 1.0));
        }
    }
        if (teamBActive && inB(hsv)) {
        atomicAdd(&statsB.cnt , 1u);
        atomicAdd(&statsB.sumX, global_id.x);
        atomicAdd(&statsB.sumY, global_id.y);
                if (previewOn) {
            textureStore(dstTex, vec2<i32>(i32(global_id.x),i32(global_id.y)),
                         vec4<f32>(0.0,0.0,1.0,1.0));
        }
    } else if (hitA && previewOn) {
        textureStore(dstTex, vec2<i32>(i32(global_id.x),i32(global_id.y)),
                     vec4<f32>(1.0,0.0,0.0,1.0));
    }
}

// ----------------------------------------------
// Full-screen triangle: pass-through UV & preview

struct VSOut {
    @builtin(position) pos : vec4<f32>,
    @location(0)       uv  : vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) idx: u32) -> VSOut {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0)
    );
    var uvs = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(2.0, 0.0),
        vec2<f32>(0.0, 2.0)
    );
    var out: VSOut;
    out.pos = vec4<f32>(positions[idx], 0.0, 1.0);
    out.uv  = uvs[idx];
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
    // Flip Y so texture space matches screen space (top-left origin)
    let uv       = vec2<f32>(in.uv.x, in.uv.y);
    let videoCol = textureSample(frame, samp, uv);

    // sample both mask channels for team A (r) and team B (b)
    let maskAB = textureSample(maskTex, samp, uv);
    let maskA  = maskAB.r;
    let maskB  = maskAB.b;

    // overlay team A in red
    let colorA = mix(videoCol.rgb,
                     vec3<f32>(1.0, 0.0, 0.0),
                     maskA * 0.6);
    // then overlay team B in blue
    let colorB = mix(colorA,
                     vec3<f32>(0.0, 0.0, 1.0),
                     maskB * 0.6);
    return vec4<f32>(colorB, 1.0);
}