/**
 * GLSL ES 3.00 shaders. Lighting is physically inspired and entirely analytic:
 *  - one rectangular overhead lamp (three panels) as an area light: diffuse via a 5×2 sample grid,
 *    mirror-like reflections via ray/lamp-plane intersection (so balls show the real rectangular
 *    lamp highlight), plus a dim hemisphere ambient with green bounce from the cloth;
 *  - Fresnel (Schlick) clearcoat on balls, varnished wood and the cue; cloth = Lambert + sheen;
 *  - contact shadows are blurred decals; cushions and pockets add an ambient-occlusion falloff;
 *  - ACES filmic tone map, sRGB encode and a subtle vignette in every lit shader.
 * Plan overlays (ribbons, dots) are unlit and keep the exact Okabe–Ito palette colours.
 */

export const MAT = { cushion: 0, wood: 1, diamond: 2, pocket: 3, liner: 4, cabinet: 5, floor: 6, cue: 7 } as const;

const COMMON = /* glsl */ `
#define PI 3.14159265359
uniform vec3 uEye;
uniform vec4 uViewport;   // device px: w, h, 1/w, 1/h
uniform vec4 uLamp;       // lamp height, half length (x), half width (y), radiance
uniform vec3 uBed;        // hx, hy, ball radius
uniform vec3 uClothLin;   // linear cloth albedo
uniform float uExposure;
const vec3 LAMP_COLOR = vec3(1.0, 0.94, 0.84);

vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 linearToSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

// Midnight Felt background: #0C1322 glow behind the table fading to #070B14.
vec3 bgAt() {
  vec2 q = gl_FragCoord.xy * uViewport.zw;
  vec2 d = (q - vec2(0.5, 0.55)) * vec2(uViewport.x * uViewport.w, 1.0);
  float r = length(d) / max(1.0, uViewport.x * uViewport.w) * 1.6;
  return mix(vec3(0.047, 0.075, 0.133), vec3(0.027, 0.043, 0.078), smoothstep(0.0, 1.0, r));
}
float vignette() {
  vec2 q = gl_FragCoord.xy * uViewport.zw - 0.5;
  return 1.0 - 0.22 * smoothstep(0.08, 0.5, dot(q, q));
}
vec4 finish(vec3 hdr) {
  vec3 c = linearToSrgb(aces(hdr * uExposure));
  return vec4(c * vignette(), 1.0);
}

// Irradiance from the rectangular lamp facing down (cosine emitter), 5×2 samples.
vec3 lampIrradiance(vec3 p, vec3 n) {
  float E = 0.0;
  for (int i = 0; i < 5; i++) {
    for (int j = 0; j < 2; j++) {
      vec3 L = vec3((float(i) * 0.5 - 1.0) * uLamp.y * 0.86, (float(j) - 0.5) * uLamp.z, uLamp.x);
      vec3 d = L - p;
      float r2 = max(dot(d, d), 1e-4);
      vec3 l = d * inversesqrt(r2);
      // Shaded fixture: emission falls off as cos² away from straight down.
      float lz = max(l.z, 0.0);
      E += max(dot(n, l), 0.0) * lz * lz / r2;
    }
  }
  float area = 4.0 * uLamp.y * uLamp.z;
  return LAMP_COLOR * (uLamp.w * area * 0.1) * E;
}
// Dim room ambient. Objects on the cloth (balls) also get green bounce light from below.
vec3 ambient(vec3 n) {
  // Soft ceiling bounce + a little cool room fill so rails and cushions read outside the lamp pool.
  // (Raised from 0.074 / 0.010: vertical cloth faces — the pocket jaws' end caps — read as black slabs.)
  vec3 sky = vec3(0.11, 0.104, 0.105);
  vec3 ground = vec3(0.02, 0.02, 0.024);
  return mix(ground, sky, clamp(n.z * 0.5 + 0.5, 0.0, 1.0)) * PI;
}
vec3 ambientBounce(vec3 n, vec3 p) {
  vec3 bounce = uClothLin * lampIrradiance(vec3(p.xy, 0.0), vec3(0.0, 0.0, 1.0)) / PI * 0.55;
  return ambient(n) + bounce * PI * clamp(-n.z * 0.6 + 0.4, 0.0, 1.0) * 0.35;
}
// Radiance seen along a reflected ray: the lamp (three panels), a dim room, the lit cloth below.
vec3 envRadianceG(vec3 p, vec3 r, float rough, float lampGain) {
  if (r.z > 1e-3) {
    float t = (uLamp.x - p.z) / r.z;
    vec2 h = p.xy + r.xy * t;
    float soft = 0.004 + rough * t * 0.55;
    float ax = smoothstep(uLamp.y + soft, uLamp.y - soft, abs(h.x));
    float hy = uLamp.z * 0.7;
    float ay = smoothstep(hy + soft, hy - soft, abs(h.y));
    float barW = 0.014;
    float bar = 1.0 - smoothstep(barW - soft, barW + soft, abs(abs(h.x) - uLamp.y / 3.0));
    // Blurring a small bright source spreads its energy: scale the peak by the area ratio.
    float spread = (uLamp.y * hy) / ((uLamp.y + soft) * (hy + soft));
    float lamp = ax * ay * (1.0 - 0.9 * bar) * spread;
    // Lamp housing (dark rim) and a faint warm ceiling.
    vec3 room = vec3(0.010, 0.011, 0.016) * (0.35 + 0.65 * r.z) + vec3(0.03, 0.025, 0.02) * exp(-length(h) * 1.2) * 0.6;
    return mix(room, LAMP_COLOR * uLamp.w * lampGain, lamp);
  }
  float t = -p.z / min(r.z, -1e-3);
  vec2 h = p.xy + r.xy * t;
  float on = step(abs(h.x), uBed.x + 0.06) * step(abs(h.y), uBed.y + 0.06);
  vec3 cloth = uClothLin * lampIrradiance(vec3(h, 0.0), vec3(0.0, 0.0, 1.0)) / PI;
  return mix(vec3(0.004, 0.004, 0.006), cloth, on * smoothstep(-0.0, -0.08, r.z));
}
vec3 envRadiance(vec3 p, vec3 r, float rough) { return envRadianceG(p, r, rough, 1.0); }
float fresnel(float f0, float ndv) { return f0 + (1.0 - f0) * pow(1.0 - ndv, 5.0); }
`;

const HOLES = /* glsl */ `
uniform vec4 uHoles[6]; // x, y, r, 0
float holeDist(vec2 p) {
  float d = 1e9;
  for (int i = 0; i < 6; i++) d = min(d, length(p - uHoles[i].xy) - uHoles[i].z);
  return d;
}
`;

// ---------------------------------------------------------------------------------------------
export const BG_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.9999, 1.0);
}`;
export const BG_FS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
out vec4 fragColor;
void main() { fragColor = vec4(bgAt() * vignette(), 1.0); }`;

// ---------------------------------------------------------------------------------------------
export const LIT_VS = /* glsl */ `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec2 aUV;
uniform mat4 uVP;
uniform mat4 uModel;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(uModel) * aNormal;
  vUV = aUV;
  gl_Position = uVP * w;
}`;

export const LIT_FS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
${HOLES}
uniform int uMat;
uniform sampler2D uTex;     // wood / cue / weave depending on material
uniform sampler2D uTex2;    // cloth weave for cushions
uniform float uRailTop;
uniform float uPocketBottom;
uniform vec3 uOuter;        // rail outer half extents + floor z
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
out vec4 fragColor;

float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uEye - vWorld);
  vec3 albedo = vec3(0.5);
  float f0 = 0.0;
  float rough = 0.3;
  float ao = 1.0;
  float specAo = 1.0;
  if (uMat == ${MAT.cushion}) {
    // Cloth-covered rubber: same cloth, a touch darker; weave mapped along the cushion.
    vec2 wuv = vec2(vWorld.x + vWorld.y, vWorld.z + (abs(N.x) > abs(N.y) ? vWorld.y : vWorld.x) * 0.0) * 20.0;
    float w = texture(uTex2, wuv).r;
    albedo = uClothLin * (0.9 + (w - 0.5) * 0.2);
    ao = mix(0.45, 1.0, smoothstep(0.0, 0.03, vWorld.z));
    // Jaws inside the pocket throat sit in the drop's shadow.
    // (Lifted from 0.3: the side-pocket facings read as flat, unlit slabs in the player view.)
    ao *= mix(0.7, 1.0, smoothstep(0.0, 0.03, holeDist(vWorld.xy)));
    // Sheen on the rounded nose.
    float sheen = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
    // Wrap-lit share of the lamp on the bed: cloth on a vertical face (the jaws' end caps, the cushion
    // faces) gets at least ~18 % of what the cloth top gets, so it reads as cloth, not a black plate.
    float wrap = (N.z * 0.5 + 0.5) * 0.36;
    vec3 E = lampIrradiance(vWorld, N) + ambient(N) + lampIrradiance(vWorld, vec3(0.0, 0.0, 1.0)) * wrap * (1.0 - max(N.z, 0.0));
    vec3 col = albedo / PI * E * ao + uClothLin * sheen * 0.35 * E / PI;
    fragColor = finish(col);
    return;
  } else if (uMat == ${MAT.wood} || uMat == ${MAT.cabinet}) {
    if (uMat == ${MAT.wood} && vWorld.z > uPocketBottom - 0.01 && holeDist(vWorld.xy) < 0.0) discard;
    vec4 t = texture(uTex, vUV * vec2(0.55, 2.6));
    albedo = srgbToLinear(t.rgb) * (uMat == ${MAT.cabinet} ? 0.45 : 1.0);
    f0 = 0.035;
    rough = mix(0.55, 0.3, t.a);
    specAo = uMat == ${MAT.cabinet} ? 0.15 : 0.45;
    // Darken the rail cap toward each pocket (leather/rubber shadow) to hide the cut edge.
    if (uMat == ${MAT.wood}) {
      float hd = holeDist(vWorld.xy);
      ao *= mix(0.45, 1.0, smoothstep(0.0, 0.006, hd));
    }
    // Cabinet sits in the shadow of the rail overhang.
    if (uMat == ${MAT.cabinet}) ao *= mix(0.35, 1.0, smoothstep(-0.6, -0.25, vWorld.z));
  } else if (uMat == ${MAT.diamond}) {
    // Mother-of-pearl inlay with a faint iridescent shift.
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    albedo = srgbToLinear(vec3(0.93, 0.9, 0.86)) * (0.92 + 0.08 * vec3(sin(ndv * 9.0), sin(ndv * 9.0 + 2.0), sin(ndv * 9.0 + 4.0)));
    f0 = 0.06;
    rough = 0.08;
  } else if (uMat == ${MAT.pocket}) {
    // Leather drop: brown at the lip, black 6 cm down (it reads as a pocket, not a hole in the render).
    albedo = srgbToLinear(vec3(0.169, 0.122, 0.094));
    ao = mix(0.03, 0.85, smoothstep(-0.06, 0.0, vWorld.z));
    f0 = 0.02;
    rough = 0.7;
    specAo = ao * 0.3;
  } else if (uMat == ${MAT.liner}) {
    // Leather lip (#2B1F18) around the drop; its rounded inner edge catches a specular rim.
    albedo = srgbToLinear(vec3(0.169, 0.122, 0.094));
    f0 = 0.045;
    rough = 0.45;
    specAo = 0.8;
  } else if (uMat == ${MAT.floor}) {
    vec2 p = vWorld.xy;
    // Dark floor that melts into the Midnight Felt background a short way from the table, with the
    // table's soft shadow beneath it: reads as a gentle drop shadow from above.
    vec4 t = texture(uTex, vec2(p.x * 0.35, p.y * 1.6));
    albedo = mix(srgbToLinear(t.rgb), vec3(0.02, 0.025, 0.04), 0.6) * 0.35;
    float sd = sdBox(p, uOuter.xy);
    ao = mix(0.05, 1.0, smoothstep(-0.2, 0.45, sd));
    vec3 E = lampIrradiance(vWorld, N) + ambient(N);
    vec4 o = finish(albedo / PI * E * ao);
    vec3 bg = bgAt() * vignette();
    float near = 1.0 - smoothstep(0.0, 0.25, sd);
    vec3 shadowed = bg * mix(1.0, 0.25, smoothstep(0.7, -0.05, sd));
    float fade = smoothstep(0.1, 1.1, sd);
    fragColor = vec4(mix(mix(shadowed, o.rgb, near * 0.6), shadowed, fade), 1.0);
    return;
  } else if (uMat == ${MAT.cue}) {
    vec4 t = texture(uTex, vUV);
    albedo = srgbToLinear(t.rgb);
    f0 = 0.04;
    rough = mix(0.45, 0.07, t.a);
  }
  vec3 E = lampIrradiance(vWorld, N) + ambient(N);
  // The far rails sit outside the lamp's pool: a little more room light keeps the wood readable.
  if (uMat == ${MAT.wood}) E += ambient(N) * 0.18;
  vec3 col = albedo / PI * E * ao;
  if (f0 > 0.0) {
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float F = fresnel(f0, ndv);
    vec3 R = reflect(-V, N);
    // Geometric specular anti-aliasing: where the normal changes faster than a pixel (rail and
    // cushion seams far away), widen the lobe instead of sparkling.
    rough = max(rough, min(0.7, 1.4 * length(fwidth(N))));
    col = col * (1.0 - F) + envRadiance(vWorld, R, rough) * F * specAo;
  }
  fragColor = finish(col);
}`;

// ---------------------------------------------------------------------------------------------
export const CLOTH_VS = /* glsl */ `#version 300 es
in vec3 aPos;
uniform mat4 uVP;
out vec3 vWorld;
void main() { vWorld = aPos; gl_Position = uVP * vec4(aPos, 1.0); }`;

export const CLOTH_FS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
${HOLES}
uniform sampler2D uWeave;
uniform sampler2D uVariation;
uniform sampler2D uHeat;
uniform float uHeatOn;
uniform vec4 uHeatRect;    // x0, y0, x1, y1
uniform vec4 uSpots[8];    // x, y, radius, style (0 dot, 1 ring)
uniform int uSpotCount;
uniform vec4 uBaulk;       // enabled, baulk-line x, D radius, line half width
in vec3 vWorld;
out vec4 fragColor;

float lineAA(float d, float halfW) { float aa = fwidth(d) * 0.8 + 1e-5; return 1.0 - smoothstep(halfW - aa, halfW + aa, d); }

void main() {
  vec2 p = vWorld.xy;
  float hd = holeDist(p);
  if (hd < 0.0) discard;
  vec2 buv = (p + uBed.xy) / (2.0 * uBed.xy);
  vec4 w = texture(uWeave, p * 18.0);
  vec4 w2 = texture(uWeave, p * 4.3 + 0.37);
  vec4 var = texture(uVariation, buv);
  float detail = (w.r - 0.52) * 0.22 + (w2.g - 0.5) * 0.07;
  vec3 albedo = uClothLin * (1.0 + detail) * (1.0 + (var.r - 0.5) * 0.09 + (var.g - 0.5) * 0.05);
  // Table markings (chalk-white): snooker baulk line + D, spots.
  float mark = 0.0;
  if (uBaulk.x > 0.5) {
    mark = max(mark, lineAA(abs(p.x - uBaulk.y), uBaulk.w) * step(abs(p.y), uBed.y));
    float dd = abs(length(p - vec2(uBaulk.y, 0.0)) - uBaulk.z);
    mark = max(mark, lineAA(dd, uBaulk.w) * step(p.x, uBaulk.y));
  }
  for (int i = 0; i < 8; i++) {
    if (i >= uSpotCount) break;
    vec4 s = uSpots[i];
    float d = length(p - s.xy);
    mark = max(mark, s.w > 0.5 ? lineAA(abs(d - s.z), s.z * 0.22) : lineAA(d, s.z));
  }
  albedo = mix(albedo, vec3(0.62, 0.62, 0.6), mark * 0.55);
  vec3 N = vec3(0.0, 0.0, 1.0);
  vec3 E = lampIrradiance(vWorld, N) + ambient(N);
  // Occlusion under the cushion noses and toward the pocket drops.
  float dEdge = min(uBed.x - abs(p.x), uBed.y - abs(p.y));
  float ao = 1.0 - 0.42 * exp(-max(dEdge, 0.0) / 0.02);
  ao *= dEdge < 0.0 ? 0.55 : 1.0;
  ao *= mix(0.2, 1.0, smoothstep(0.0, 0.016, hd));
  vec3 col = albedo / PI * E * ao;
  // Velvet sheen at grazing angles (visible in the player view).
  vec3 V = normalize(uEye - vWorld);
  float sheen = pow(1.0 - clamp(V.z, 0.0, 1.0), 4.0);
  col += uClothLin * sheen * 0.55 * E / PI * ao;
  vec4 o = finish(col);
  // Position heatmap (Okabe–Ito yellow, like the 2D table view): bright = easy next shot. Alpha
  // grows with quality so the good zones glow and poor zones stay plain cloth; edges feathered.
  if (uHeatOn > 0.5) {
    vec2 huv = (p - uHeatRect.xy) / (uHeatRect.zw - uHeatRect.xy);
    vec2 edge = min(huv, 1.0 - huv);
    float feather = smoothstep(0.0, 0.02, min(edge.x, edge.y * 2.0));
    if (feather > 0.0) {
      float v = texture(uHeat, clamp(huv, 0.0, 1.0)).r;
      float a = smoothstep(0.05, 0.12, v) * (0.1 + 0.55 * v * v) * feather;
      o.rgb = mix(o.rgb, vec3(0.941, 0.894, 0.259), a);
    }
  }
  fragColor = o;
}`;

// ---------------------------------------------------------------------------------------------
export const BALL_VS = /* glsl */ `#version 300 es
in vec3 aPos;
uniform mat4 uVP;
uniform mat3 uRot;
uniform vec3 uCenter;
uniform float uRadius;
out vec3 vLocal;
void main() {
  vLocal = aPos;
  vec3 w = uCenter + uRot * aPos * uRadius;
  gl_Position = uVP * vec4(w, 1.0);
}`;

export const BALL_FS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
uniform mat3 uRot;
uniform vec3 uCenter;
uniform float uRadius;
uniform vec3 uBallColor;   // linear
uniform vec4 uBallKind;    // stripe, number slot (−1 none), cue dots, highlight
uniform sampler2D uNumbers;
in vec3 vLocal;
out vec4 fragColor;

const float CIRCLE_COS = 0.924;   // number circle angular radius ≈ 22.5°
const float CIRCLE_TAN = 0.414;

void main() {
  vec3 nl = normalize(vLocal);
  vec3 N = normalize(uRot * nl);
  vec3 P = uCenter + N * uRadius;
  vec3 V = normalize(uEye - P);
  vec3 ivory = vec3(0.86, 0.83, 0.75);
  vec3 base = uBallColor;
  if (uBallKind.x > 0.5) {
    float aa = fwidth(nl.z) * 0.9 + 1e-4;
    float band = 1.0 - smoothstep(0.52 - aa, 0.52 + aa, abs(nl.z));
    base = mix(ivory, uBallColor, band);
  }
  if (uBallKind.y > -0.5) {
    float ax = abs(nl.x);
    float aa = fwidth(ax) * 0.9 + 1e-4;
    float circle = smoothstep(CIRCLE_COS - aa, CIRCLE_COS + aa, ax);
    base = mix(base, ivory, circle);
    if (ax > CIRCLE_COS - 0.02) {
      // Gnomonic projection onto the circle's tangent plane: undistorted numbers.
      vec2 st = vec2(nl.y / nl.x, nl.z / ax) / CIRCLE_TAN;
      float slot = uBallKind.y;
      vec2 cell = vec2(mod(slot, 4.0), floor(slot / 4.0));
      vec2 uv = (cell + 0.5 + vec2(st.x, -st.y) * 0.5) / 4.0;
      float ink = texture(uNumbers, uv).a * circle;
      base = mix(base, vec3(0.012), ink);
    }
  }
  if (uBallKind.z > 0.5) {
    // Training cue ball: six faint red dots on the ±x, ±y, ±z axes so spin and roll are visible.
    vec3 a = abs(nl);
    float m = max(a.x, max(a.y, a.z));
    float aa = fwidth(m) * 0.9 + 1e-4;
    float dot6 = smoothstep(0.9925 - aa, 0.9925 + aa, m);
    base = mix(base, vec3(0.445, 0.042, 0.042), dot6 * 0.85); // #B23A3A: crisp red measles, not dirt
  }
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  vec3 R = reflect(-V, N);
  float F = fresnel(0.05, ndv);
  vec3 E = lampIrradiance(P, N) + ambientBounce(N, P);
  // Contact occlusion: the cloth hides the bottom of the ball from the room.
  float ao = mix(0.35, 1.0, smoothstep(-1.0, 0.15, N.z));
  vec3 col = base / PI * E * ao * (1.0 - F);
  col += envRadianceG(P, R, 0.015, 0.55) * F * mix(0.5, 1.0, smoothstep(-0.6, 0.2, R.z));
  // Broad sheen from micro-scratches in the resin (Blinn lobe toward the lamp centre).
  vec3 L = normalize(vec3(0.0, 0.0, uLamp.x) - P);
  vec3 H = normalize(L + V);
  col += LAMP_COLOR * pow(max(dot(N, H), 0.0), 90.0) * 0.06 * uLamp.w * 0.04;
  vec4 o = finish(col);
  // Selection highlight rim (target ball), drawn in sRGB so it reads as UI: white, like its ring
  // (yellow would read as the 1-ball's colour).
  if (uBallKind.w > 0.5) o.rgb = mix(o.rgb, vec3(1.0), pow(1.0 - ndv, 3.0) * 0.5);
  fragColor = o;
}`;

// ---------------------------------------------------------------------------------------------
export const GHOST_FS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
uniform mat3 uRot;
uniform vec3 uCenter;
uniform float uRadius;
uniform vec4 uColor;
in vec3 vLocal;
out vec4 fragColor;
void main() {
  vec3 N = normalize(uRot * normalize(vLocal));
  vec3 P = uCenter + N * uRadius;
  vec3 V = normalize(uEye - P);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float rim = pow(1.0 - ndv, 2.2);
  vec3 R = reflect(-V, N);
  vec3 spec = aces(envRadiance(P, R, 0.03) * fresnel(0.05, ndv) * uExposure);
  vec3 col = uColor.rgb + spec * 0.8;
  float a = uColor.a * (0.16 + 0.7 * rim) + max(spec.r, spec.g) * 0.5;
  fragColor = vec4(col, clamp(a, 0.0, 0.85));
}`;

// ---------------------------------------------------------------------------------------------
export const DECAL_VS = /* glsl */ `#version 300 es
in vec3 aPos;
uniform mat4 uVP;
uniform vec3 uCenter;
uniform vec2 uAxisX;
uniform vec2 uAxisY;
out vec2 vQ;
void main() {
  vQ = aPos.xy;
  vec3 w = vec3(uCenter.xy + aPos.x * uAxisX + aPos.y * uAxisY, uCenter.z);
  gl_Position = uVP * vec4(w, 1.0);
}`;

export const DECAL_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 uColor;   // rgb + strength
uniform int uMode;     // 0 contact shadow (darken), 1 glow (additive)
uniform float uCore;   // relative radius of the dark contact core (shadow)
in vec2 vQ;
out vec4 fragColor;
void main() {
  float d = length(vQ);
  if (d >= 1.0) discard;
  if (uMode == 0) {
    // Penumbra of the wide overhead lamp plus a tight ambient-occlusion core at the contact.
    float soft = 1.0 - smoothstep(uCore, 1.0, d);
    soft *= soft;
    float core = exp(-pow(d / max(uCore, 1e-3), 2.0) * 1.6);
    fragColor = vec4(0.0, 0.0, 0.0, clamp(uColor.a * (soft * 0.85 + core * 0.35), 0.0, 0.92));
  } else {
    float g = pow(1.0 - d, 2.0);
    fragColor = vec4(uColor.rgb * g * uColor.a, g * uColor.a);
  }
}`;

// ---------------------------------------------------------------------------------------------
export const LINE_VS = /* glsl */ `#version 300 es
in vec3 aPos;
in vec3 aPrev;
in vec3 aNext;
in float aSide;
in float aU;
uniform mat4 uVP;
uniform vec4 uViewport;
uniform float uFocal;    // projection focal length in device px
uniform vec3 uWidth;     // world width (m), min width (device px), halo (device px)
uniform float uNear;
out float vDist;
out float vHalf;
out float vU;

vec4 toNear(vec4 c, vec4 o) {
  if (c.w >= uNear || o.w < uNear) return c;
  return mix(c, o, (uNear - c.w) / (o.w - c.w));
}

void main() {
  vec4 c = uVP * vec4(aPos, 1.0);
  vec4 p = uVP * vec4(aPrev, 1.0);
  vec4 n = uVP * vec4(aNext, 1.0);
  if (c.w < uNear) c = toNear(c, n.w >= uNear ? n : p);
  p = toNear(p, c);
  n = toNear(n, c);
  vec2 half_res = 0.5 * uViewport.xy;
  vec2 sc = c.xy / c.w * half_res;
  vec2 sp = p.xy / p.w * half_res;
  vec2 sn = n.xy / n.w * half_res;
  vec2 d1 = sc - sp;
  vec2 d2 = sn - sc;
  float l1 = length(d1);
  float l2 = length(d2);
  if (l1 < 1e-4) { d1 = d2; l1 = l2; }
  if (l2 < 1e-4) { d2 = d1; l2 = l1; }
  if (l1 < 1e-4 || c.w < uNear) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); vDist = 0.0; vHalf = 1.0; vU = aU; return; }
  d1 /= l1;
  d2 /= l2;
  vec2 t = d1 + d2;
  float lt = length(t);
  t = lt < 1e-3 ? d1 : t / lt;
  vec2 nrm = vec2(-t.y, t.x);
  float miter = 1.0 / max(dot(nrm, vec2(-d1.y, d1.x)), 0.45);
  float halfPx = max(uWidth.x * uFocal / c.w, uWidth.y) * 0.5 + uWidth.z;
  vec2 off = nrm * aSide * halfPx * miter;
  gl_Position = vec4(c.xy + off / half_res * c.w, c.z, c.w);
  vDist = aSide * halfPx;
  vHalf = halfPx;
  vU = aU;
}`;

export const LINE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 uViewport;
uniform vec4 uColor;
uniform vec4 uHalo;
uniform vec4 uDash;      // on, off, on2, off2 (m); on <= 0 → solid
uniform vec3 uWidth;
uniform mat4 uVP;
uniform mat4 uInvVP;
uniform float uPlaneZ;
in float vDist;
in float vHalf;
in float vU;
out vec4 fragColor;

float band(float s, float len, float aa) { return smoothstep(-aa, aa, s) * (1.0 - smoothstep(len - aa, len + aa, s)); }
float dashMask(float u) {
  if (uDash.x <= 0.0) return 1.0;
  float period = uDash.x + uDash.y + uDash.z + uDash.w;
  float s = mod(u, period);
  float aa = max(fwidth(u) * 0.75, 1e-5);
  float a = band(s, uDash.x, aa) + band(s - period, uDash.x, aa);
  if (uDash.z > 0.0) a = max(a, band(s - uDash.x - uDash.y, uDash.z, aa));
  return clamp(a, 0.0, 1.0);
}
// Depth of the horizontal plane z = uPlaneZ at this pixel: the ribbon behaves like a decal on the
// cloth (occluded by cushions/rails/balls exactly as the cloth is) despite its screen-space width.
float planeDepth() {
  vec2 ndc = gl_FragCoord.xy * uViewport.zw * 2.0 - 1.0;
  vec4 a = uInvVP * vec4(ndc, -1.0, 1.0);
  vec4 b = uInvVP * vec4(ndc, 1.0, 1.0);
  a /= a.w;
  b /= b.w;
  float dz = b.z - a.z;
  if (abs(dz) < 1e-9) return gl_FragCoord.z;
  float t = (uPlaneZ - a.z) / dz;
  if (t <= 0.0) return gl_FragCoord.z;
  vec4 c = uVP * vec4(mix(a.xyz, b.xyz, t), 1.0);
  return clamp(c.z / c.w * 0.5 + 0.5 - 2e-6, 0.0, 1.0);
}
void main() {
  float d = abs(vDist);
  float core = vHalf - uWidth.z;
  float aCore = 1.0 - smoothstep(core - 0.75, core + 0.75, d);
  float aAll = 1.0 - smoothstep(vHalf - 1.1, vHalf, d);
  float dm = dashMask(vU);
  float alpha = max(aCore * uColor.a, aAll * uHalo.a) * dm;
  if (alpha < 0.003) discard;
  vec3 col = mix(uHalo.rgb, uColor.rgb, aCore);
  fragColor = vec4(col, alpha);
  gl_FragDepth = planeDepth();
}`;

// ---------------------------------------------------------------------------------------------
export const DOT_VS = /* glsl */ `#version 300 es
in vec3 aPos;
uniform mat4 uVP;
uniform vec3 uEye;
uniform vec3 uPoint;
uniform float uSize;
uniform float uPull;
void main() {
  vec3 p = uPoint + normalize(uEye - uPoint) * uPull + aPos * 0.0;
  gl_Position = uVP * vec4(p, 1.0);
  gl_PointSize = uSize;
}`;

export const DOT_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 uColor;
uniform vec4 uRing;
uniform float uSize;
out vec4 fragColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = length(q);
  float aa = 2.0 / max(uSize, 1.0);
  float inner = 1.0 - smoothstep(0.6 - aa, 0.6 + aa, r);
  float outer = 1.0 - smoothstep(1.0 - 2.0 * aa, 1.0, r);
  if (outer <= 0.0) discard;
  fragColor = vec4(mix(uRing.rgb, uColor.rgb, inner), outer * mix(uRing.a, uColor.a, inner));
}`;
