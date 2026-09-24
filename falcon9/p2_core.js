/* ====================================================================
   FALCON 9 / STARLINK - procedural ascent simulation
   --------------------------------------------------------------------
   Everything below is generated at runtime: no meshes, no textures and
   no images are loaded. The only network fetch is the three.js module
   itself.

   Layout of this file
     0  module loader
     1  constants: vehicle geometry, mass/thrust, atmosphere
     2  small maths kit (noise, easing, table interpolation)
     3  renderer, scene, lighting
     4  sky dome (custom gradient + sun + stars shader)
     5  terrain and the concrete pad (procedural canvas textures)
     6  pad structures: mount, flame deflector, strongback, masts
     7  the vehicle: booster, legs, grid fins, interstage, stage 2, fairing
     8  exhaust: one premultiplied-alpha particle system + a shock-cell jet
     9  flight dynamics: the integrator and the guidance/throttle programme
    10  camera director + procedural shake
    11  HUD binding and the main loop
   ==================================================================== */

/* -- 0 -- module loader ---------------------------------------------
   Three.js is pulled as an ES module from a CDN, so the page runs from
   a file:// URL with no build step. Two mirrors of the same major are
   tried before giving up, and the failure is reported in the UI rather
   than dying silently in the console.                                */
const CDN_SOURCES = [
  'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
  'https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js',
  'https://cdn.jsdelivr.net/npm/three@0.159.0/build/three.module.js'
];

let THREE = null;
let loadError = null;
for (const url of CDN_SOURCES) {
  try { THREE = await import(url); break; }
  catch (err) { loadError = err; }
}

const $ = (id) => document.getElementById(id);

if (!THREE) {
  const box = $('err');
  box.hidden = false;
  box.textContent =
    'Could not load three.js from the CDN (' + (loadError && loadError.message) + '). ' +
    'Check the network, or serve this folder over HTTP: python3 -m http.server 8000';
  $('go').disabled = true;
  throw new Error('three.js unavailable');
}

const { Vector3, Vector2, Quaternion, Euler, Color, Matrix4 } = THREE;

/* -- 1 -- constants --------------------------------------------------
   Real Falcon 9 Block 5 figures. Distances are metres, masses kilograms,
   forces newtons, and one world unit is one metre throughout.        */

/* Station line: every part of the vehicle is authored at its true height
   above the engine gimbal plane, so the stack assembles itself.       */
const V = {
  R:            1.83,   // core radius, 3.66 m diameter
  ENGINE_BAY:   3.20,   // octaweb / thrust structure top
  S1_TOP:      40.00,   // top of the first-stage LOX tank
  INTER_TOP:   46.00,   // top of the black composite interstage
  S2_TOP:      57.00,   // top of the second stage
  FAIR_R:       2.60,   // 5.2 m fairing diameter
  FAIR_SHOULD: 59.60,   // fairing shoulder: the taper ends here
  FAIR_CYL:    65.10,   // top of the fairing barrel section
  TOP:         70.00    // nose cap
};

const P = {
  g0:      9.80665,     // standard gravity
  Re:   6371000,        // mean Earth radius, for the inverse-square falloff
  H:       8500,        // atmospheric scale height (m)
  rho0:    1.225,       // sea-level density (kg/m^3)
  p0:    101325,        // sea-level pressure (Pa)

  /* Stage 1: nine Merlin 1D engines. */
  m1_dry:   25600, m1_prop: 411000,
  T1_sl:  7607000, T1_vac: 8227000,
  isp1_sl:    282, isp1_vac:  311,

  /* Stage 2: one Merlin Vacuum. */
  m2_dry:    3900, m2_prop: 107500,
  T2_vac:  981000, isp2_vac:  348,

  payload:  17400,      // ~56 Starlink v2 mini plus the dispenser stack
  fairing:    1900,     // both halves

  A_core: Math.PI * 1.83 * 1.83,   // 10.5 m^2 reference area, bare core
  A_fair: Math.PI * 2.60 * 2.60,   // 21.2 m^2 while the fairing is on

  G_LIMIT: 4.2          // axial load the guidance holds the stack under
};

/* Propellant flow follows straight from thrust and specific impulse:
   mdot = F / (Isp * g0).  ~2751 kg/s for nine Merlins at sea level.   */
P.mdot1 = P.T1_sl / (P.isp1_sl * P.g0);
P.mdot2 = P.T2_vac / (P.isp2_vac * P.g0);
P.m0 = P.m1_dry + P.m1_prop + P.m2_dry + P.m2_prop + P.payload + P.fairing;

/* Speed of sound against geometric altitude (US Standard Atmosphere,
   sampled at the layer boundaries; linear between them). */
const SOS_TABLE = [
  [0, 340.3], [11000, 295.1], [20000, 295.1], [32000, 303.1],
  [47000, 329.8], [51000, 329.8], [71000, 295.1], [86000, 274.1]
];

/* Drag coefficient against Mach for a slender launch vehicle: the
   transonic rise near M 1.05, then the steady supersonic decay.       */
const CD_TABLE = [
  [0, 0.30], [0.60, 0.30], [0.90, 0.42], [1.05, 0.62], [1.30, 0.57],
  [2.00, 0.41], [3.00, 0.31], [5.00, 0.25], [10.0, 0.21]
];

/* Open-loop throttle schedule (seconds after release -> fraction).
   The bucket through 38-74 s is the real load-relief throttle-down that
   carries the vehicle through max dynamic pressure. */
const THROTTLE_TABLE = [
  [0, 1.00], [30, 1.00], [38, 0.72], [62, 0.72], [76, 1.00], [200, 1.00]
];

const SEQUENCE = [
  { t:  -2.0, key: 'ignition', label: 'Engine ignition' },
  { t:   0.0, key: 'liftoff',  label: 'Liftoff' },
  { t:  12.0, key: 'pitch',    label: 'Pitch / roll program' },
  { t:  null, key: 'maxq',     label: 'Max Q' },
  { t:  null, key: 'meco',     label: 'MECO' },
  { t:  null, key: 'sep',      label: 'Stage separation' },
  { t:  null, key: 'ses1',     label: 'SES-1' },
  { t:  null, key: 'fairing',  label: 'Fairing deploy' },
  { t:  null, key: 'seco',     label: 'SECO-1' }
];

/* -- 2 -- maths kit --------------------------------------------------- */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const lerp  = (a, b, t) => a + (b - a) * t;
const invLerp = (a, b, v) => (v - a) / (b - a);
const smoothstep = (a, b, v) => { const t = clamp(invLerp(a, b, v), 0, 1); return t * t * (3 - 2 * t); };
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
const rand = (a, b) => a + Math.random() * (b - a);

/* Linear interpolation across a sorted [x, y] table. */
function tableLookup(table, x) {
  if (x <= table[0][0]) return table[0][1];
  const n = table.length;
  if (x >= table[n - 1][0]) return table[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1], [x1, y1] = table[i];
      return lerp(y0, y1, (x - x0) / (x1 - x0));
    }
  }
  return table[n - 1][1];
}

/* Deterministic 1-D value noise. Integer lattice hashed to [-1, 1] and
   smoothstep-interpolated; three octaves give the camera a shake that
   reads as mechanical rather than as white noise. */
function hash1(n) {
  n = (n << 13) ^ n;
  return 1.0 - ((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824.0;
}
function vnoise(x) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}
function fbm(x) {
  return vnoise(x) * 0.54 + vnoise(x * 2.13 + 17.3) * 0.29 + vnoise(x * 4.61 + 41.7) * 0.17;
}

/* Atmosphere: an isothermal exponential model. Density and pressure both
   fall as exp(-h / H), which is accurate enough through the troposphere
   and stratosphere to put max Q where it really happens (~12 km). */
const density  = (h) => h > 90000 ? 0 : P.rho0 * Math.exp(-h / P.H);
const pressure = (h) => h > 90000 ? 0 : P.p0  * Math.exp(-h / P.H);
/* Inverse-square gravity - by 200 km it has already dropped 6%. */
const gravity  = (h) => P.g0 * Math.pow(P.Re / (P.Re + h), 2);

/* Procedural canvas textures. Nothing is fetched; every surface detail
   below is drawn with 2-D canvas calls and uploaded as a CanvasTexture. */
function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return { c, g: c.getContext('2d') };
}
function asTexture(canvas, repeat) {
  const t = new THREE.CanvasTexture(canvas);
  if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
  }
  return t;
}
