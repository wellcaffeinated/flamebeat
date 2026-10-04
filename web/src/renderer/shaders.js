// WGSL for the fractal flame: chaos-game compute, histogram decay, tone map.
//
// Histogram: 4 x atomic<u32> per pixel (density, R, G, B) in fixed point.
// Every hit adds DENS_ONE to density and palette * COLOR_ONE to R/G/B, so
// the decay pass (which multiplies by `decay` < 1 each frame) keeps some
// fractional precision instead of truncating single hits straight to 0.

export const MAX_XFORMS = 8;          // + 1 final transform at index MAX_XFORMS
export const XFORM_FLOATS = 20;       // 5 x vec4f
export const PARAMS_BYTES = 96;
export const DENS_ONE = 256;
export const COLOR_ONE = 255;

export const VARIATIONS = [
  'linear', 'sinusoidal', 'spherical', 'swirl',
  'horseshoe', 'polar', 'heart', 'disc',
  'spiral', 'julia',
];

const common = /* wgsl */`
struct Params {
  dims: vec4u,   // hist w, hist h, n xforms, has final
  iter: vec4u,   // iters per thread, frame seed, n chains, unused
  cam:  vec4f,   // centre x, centre y, zoom, rotation (rad)
  tone: vec4f,   // brightness, gamma, vibrancy, k2 (density scale)
  bg:   vec4f,   // background rgb, palette offset
  misc: vec4f,   // decay, unused...
};

struct Xform {
  aff0: vec4f,   // a b c d     x' = a x + b y + c
  aff1: vec4f,   // e f color colorSpeed     y' = d x + e y + f
  w0:   vec4f,   // linear sinusoidal spherical swirl
  w1:   vec4f,   // horseshoe polar heart disc
  w2:   vec4f,   // spiral julia cumulativeWeight opacity
};

const DENS_ONE: f32 = ${DENS_ONE}.0;
const COLOR_ONE: f32 = ${COLOR_ONE}.0;
`;

export const computeWGSL = common + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> X: array<Xform, ${MAX_XFORMS + 1}>;
@group(0) @binding(2) var<storage, read> palette: array<vec4f, 256>;
@group(0) @binding(3) var<storage, read_write> points: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> rng: array<u32>;
@group(0) @binding(5) var<storage, read_write> hist: array<atomic<u32>>;

const PI: f32 = 3.14159265358979;

var<private> seed: u32;

fn pcg() -> u32 {
  seed = seed * 747796405u + 2891336453u;
  let w = ((seed >> ((seed >> 28u) + 4u)) ^ seed) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rand() -> f32 { return f32(pcg() >> 8u) * (1.0 / 16777216.0); }

fn applyXform(xf: Xform, p: vec2f) -> vec2f {
  let x = xf.aff0.x * p.x + xf.aff0.y * p.y + xf.aff0.z;
  let y = xf.aff0.w * p.x + xf.aff1.x * p.y + xf.aff1.y;
  let r2 = max(x * x + y * y, 1e-12);
  let r = sqrt(r2);
  let theta = atan2(x, y);     // Draves & Reckase: theta = atan(x / y)
  var o = vec2f(0.0);
  // linear
  o += xf.w0.x * vec2f(x, y);
  // sinusoidal
  if (xf.w0.y != 0.0) { o += xf.w0.y * vec2f(sin(x), sin(y)); }
  // spherical
  if (xf.w0.z != 0.0) { o += xf.w0.z * vec2f(x, y) / r2; }
  // swirl
  if (xf.w0.w != 0.0) {
    let s = sin(r2); let c = cos(r2);
    o += xf.w0.w * vec2f(x * s - y * c, x * c + y * s);
  }
  // horseshoe
  if (xf.w1.x != 0.0) { o += xf.w1.x * vec2f((x - y) * (x + y), 2.0 * x * y) / r; }
  // polar
  if (xf.w1.y != 0.0) { o += xf.w1.y * vec2f(theta / PI, r - 1.0); }
  // heart
  if (xf.w1.z != 0.0) { o += xf.w1.z * r * vec2f(sin(theta * r), -cos(theta * r)); }
  // disc
  if (xf.w1.w != 0.0) { o += xf.w1.w * (theta / PI) * vec2f(sin(PI * r), cos(PI * r)); }
  // spiral
  if (xf.w2.x != 0.0) { o += xf.w2.x * vec2f(cos(theta) + sin(r), sin(theta) - cos(r)) / r; }
  // julia
  if (xf.w2.y != 0.0) {
    let omega = select(0.0, PI, (pcg() & 1u) == 1u);
    let a = atan2(y, x) * 0.5 + omega;
    o += xf.w2.y * sqrt(r) * vec2f(cos(a), sin(a));
  }
  return o;
}

fn bad(p: vec2f) -> bool {
  return !(abs(p.x) < 1e6 && abs(p.y) < 1e6);   // also catches NaN
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.iter.z) { return; }
  seed = rng[i] ^ (P.iter.y * 2654435761u);
  var s = points[i];
  var p = s.xy;
  var c = s.z;
  let nx = P.dims.z;
  let w = P.dims.x;
  let h = P.dims.y;
  let ca = cos(P.cam.w);
  let sa = sin(P.cam.w);
  let scale = P.cam.z * f32(h) * 0.5;

  for (var k = 0u; k < P.iter.x; k++) {
    // pick a transform by cumulative weight
    let u = rand();
    var j = 0u;
    for (; j + 1u < nx; j++) { if (u < X[j].w2.z) { break; } }
    let xf = X[j];
    p = applyXform(xf, p);
    c = mix(c, xf.aff1.z, xf.aff1.w);
    if (bad(p)) {
      p = vec2f(rand() * 2.0 - 1.0, rand() * 2.0 - 1.0);
      continue;
    }
    var q = p;
    var cq = c;
    if (P.dims.w == 1u) {
      let fx = X[${MAX_XFORMS}u];
      q = applyXform(fx, q);
      cq = mix(cq, fx.aff1.z, fx.aff1.w);
    }
    // camera
    let d = q - P.cam.xy;
    let v = vec2f(d.x * ca - d.y * sa, d.x * sa + d.y * ca) * scale;
    let px = v.x + f32(w) * 0.5;
    let py = f32(h) * 0.5 - v.y;
    if (px < 0.0 || py < 0.0 || px >= f32(w) || py >= f32(h)) { continue; }
    if (xf.w2.w < 1.0 && rand() > xf.w2.w) { continue; }   // opacity
    let idx = (u32(py) * w + u32(px)) * 4u;
    let pc = fract(cq + P.bg.w);
    let col = palette[min(u32(pc * 256.0), 255u)].rgb;
    atomicAdd(&hist[idx], u32(DENS_ONE));
    atomicAdd(&hist[idx + 1u], u32(col.r * COLOR_ONE + 0.5));
    atomicAdd(&hist[idx + 2u], u32(col.g * COLOR_ONE + 0.5));
    atomicAdd(&hist[idx + 3u], u32(col.b * COLOR_ONE + 0.5));
  }
  points[i] = vec4f(p, c, 0.0);
  rng[i] = seed;
}
`;

export const decayWGSL = common + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> hist: array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = P.dims.x * P.dims.y * 4u;
  // 2D dispatch so large canvases stay under the 65535 workgroups-per-dim limit
  let i = gid.x + gid.y * 65535u * 256u;
  if (i >= n) { return; }
  let decay = P.misc.x;
  if (decay >= 1.0) { return; }
  // clamp before scaling so a hot pixel can never wrap around u32
  let v = min(hist[i], 0x7fffffffu);
  hist[i] = u32(f32(v) * decay);
}
`;

export const toneWGSL = common + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> hist: array<u32>;

struct VOut { @builtin(position) pos: vec4f };

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  // full-screen triangle
  let uv = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: VOut;
  o.pos = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let w = P.dims.x;
  let xy = vec2u(in.pos.xy);
  let idx = (min(xy.y, P.dims.y - 1u) * w + min(xy.x, w - 1u)) * 4u;
  let a = f32(hist[idx]) / DENS_ONE;                 // decayed hit count
  let csum = vec3f(f32(hist[idx + 1u]), f32(hist[idx + 2u]), f32(hist[idx + 3u])) / COLOR_ONE;
  let bg = P.bg.rgb;
  if (a <= 0.0) { return vec4f(bg, 1.0); }

  let brightness = P.tone.x;
  let gamma = P.tone.y;
  let vib = P.tone.z;
  let k2 = P.tone.w;

  // flam3-style log-density tone map
  let ls = 0.1 * brightness * log(1.0 + a * k2) / a;
  let alpha = ls * a;
  let col = csum * ls;
  let ag = pow(alpha, 1.0 / gamma);
  let newls = ag / alpha;
  var o = vib * newls * col + (1.0 - vib) * pow(max(col, vec3f(0.0)), vec3f(1.0 / gamma));
  o += (1.0 - clamp(ag, 0.0, 1.0)) * bg;
  return vec4f(clamp(o, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
