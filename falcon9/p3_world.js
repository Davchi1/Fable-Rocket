/* -- 3 -- renderer, scene, lighting ---------------------------------- */
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, stencil: false, powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new Color(0x8fb4d6);

/* A 24-bit depth buffer distributes precision hyperbolically, so a near
   plane of 0.5 m keeps millimetre resolution around the pad - the only
   place in this scene where surfaces are close enough to fight - while
   the far plane still reaches past the sky dome. */
const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.5, 200000);
camera.position.set(72, 26, 88);

/* Sun placed low enough to rim-light the vehicle down one side. */
const SUN_DIR = new Vector3(0.50, 0.56, 0.66).normalize();

const hemi = new THREE.HemisphereLight(0xa6c9ea, 0x574f43, 0.85);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff1dc, 2.7);
sun.position.copy(SUN_DIR).multiplyScalar(400);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 20;
sun.shadow.camera.far = 900;
sun.shadow.camera.left = -150; sun.shadow.camera.right = 150;
sun.shadow.camera.top = 190;   sun.shadow.camera.bottom = -40;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.7;
scene.add(sun);
scene.add(sun.target);

scene.add(new THREE.AmbientLight(0x35465c, 0.5));

/* Engine light. A shadow-casting point light is six render passes, so it
   is switched off the moment the vehicle is too high for its shadows to
   land on anything - see updateEngineLight(). */
const engineLight = new THREE.PointLight(0xffb070, 0, 420, 2);
engineLight.castShadow = true;
engineLight.shadow.mapSize.set(1024, 1024);
engineLight.shadow.camera.near = 1.5;
engineLight.shadow.camera.far = 320;
engineLight.shadow.bias = -0.004;
engineLight.shadow.normalBias = 0.5;
scene.add(engineLight);

/* A second, cheaper light with no shadow carries the wide orange wash
   across the pad so the scene still reads once the shadow pass is off. */
const glowLight = new THREE.PointLight(0xff8a3c, 0, 900, 2);
scene.add(glowLight);

const fog = new THREE.FogExp2(0xa9c6df, 0.00034);
scene.fog = fog;

/* -- 4 -- sky dome ---------------------------------------------------
   One inverted sphere that follows the camera. The fragment shader mixes
   a horizon-to-zenith gradient, a star field and the sun's disc plus
   halo; the uniforms are re-driven every frame from altitude, which is
   what turns a blue sky into the thin lit limb of an atmosphere seen
   from above.                                                         */
const skyUniforms = {
  uZenith:     { value: new Color(0x2a63b8) },
  uHorizon:    { value: new Color(0xc2d9ec) },
  uGround:     { value: new Color(0x8d8578) },
  uSun:        { value: SUN_DIR.clone() },
  uSunColor:   { value: new Color(0xfff4e2) },
  uStars:      { value: 0.0 },
  uHaze:       { value: 1.0 },
  uHorizonPow: { value: 0.42 }
};

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(120000, 48, 32),
  new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      precision highp float;
      uniform vec3  uZenith, uHorizon, uGround, uSun, uSunColor;
      uniform float uStars, uHaze, uHorizonPow;
      varying vec3 vDir;

      float h3(vec3 p){
        return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
      }

      void main(){
        vec3 d = normalize(vDir);

        // Vertical gradient. uHorizonPow controls how tightly the bright
        // band hugs the horizon: near 0.4 it is a broad daylight sky, near
        // 6 it is the thin lit limb you see from the edge of space.
        float t = pow(clamp(d.y, 0.0, 1.0), uHorizonPow);
        vec3 col = mix(uHorizon, uZenith, t);

        // Below the horizon line, fade into ground haze.
        col = mix(col, uGround, smoothstep(0.0, -0.10, d.y));

        // Stars: hash one candidate per cell of a quantised direction
        // grid, then weight it with a gaussian on the in-cell offset so it
        // resolves as a soft point instead of aliasing into a firefly.
        if (uStars > 0.001) {
          vec3 p = d * 320.0;
          vec3 id = floor(p), f = fract(p) - 0.5;
          float n = h3(id);
          float star = smoothstep(0.974, 1.0, n) * exp(-dot(f, f) * 40.0);
          vec3 tint = mix(vec3(0.74, 0.84, 1.0), vec3(1.0, 0.91, 0.78), h3(id + 3.1));
          col += tint * star * uStars * 2.6;
        }

        // Sun: a hard disc wrapped in a wide forward-scattering halo that
        // dies away with the atmosphere.
        float sd = max(dot(d, uSun), 0.0);
        col += uSunColor * (pow(sd, 1800.0) * 16.0 + pow(sd, 9.0) * 0.32 * uHaze);

        gl_FragColor = vec4(col, 1.0);
      }`
  })
);
sky.frustumCulled = false;
sky.renderOrder = -1;   // always laid down first; it writes colour, never depth
scene.add(sky);

const SKY_DAY_ZENITH  = new Color(0x2a63b8);
const SKY_DAY_HORIZON = new Color(0xc6dced);
const SKY_SPACE       = new Color(0x02030a);
const SKY_HIGH_HORIZ  = new Color(0x1f5fa8);
const _c1 = new Color(), _c2 = new Color();

function updateSky(alt) {
  // Fraction of the atmosphere still overhead. 26 km is a visual scale
  // height chosen so the sky is clearly black by ~70 km.
  const atmo = Math.exp(-Math.max(alt, 0) / 26000);

  _c1.copy(SKY_SPACE).lerp(SKY_DAY_ZENITH, Math.pow(atmo, 1.25));
  skyUniforms.uZenith.value.copy(_c1);

  _c2.copy(SKY_HIGH_HORIZ).lerp(SKY_DAY_HORIZON, Math.pow(atmo, 0.55));
  skyUniforms.uHorizon.value.copy(_c2);

  skyUniforms.uHorizonPow.value = lerp(0.42, 7.0, 1 - atmo);
  skyUniforms.uStars.value = smoothstep(16000, 62000, alt);
  skyUniforms.uHaze.value = atmo;
  skyUniforms.uGround.value.copy(_c2).multiplyScalar(0.62);

  fog.density = 0.00034 * atmo;
  fog.color.copy(_c2);
  scene.background.copy(_c2);

  // Sunlight loses its atmospheric warmth and softening with altitude.
  hemi.intensity = lerp(0.18, 0.85, atmo);
  sun.intensity = lerp(3.4, 2.7, atmo);
}

/* -- 5 -- terrain and pad surface ------------------------------------
   Two surfaces. A 45 km disc carries the coastline as one radial canvas
   texture (the CircleGeometry UVs map the disc onto the unit square, so a
   radial image lines up exactly), and a 900 m concrete plane sits on top
   of it with a tiling pad texture.                                     */
const COAST_R = 45000;       // radius of the terrain disc
const COAST_K = 20000 / COAST_R;  // keeps the coastline at its real distance

function makeCoastTexture() {
  const N = 768;
  const { c, g } = makeCanvas(N);
  const img = g.createImageData(N, N);
  const d = img.data;
  const half = N / 2;

  // Bands are given as [outer radius (fraction of the disc), r, g, b].
  const BANDS = [
    [0.030 * COAST_K, 168, 166, 160],  // pad concrete
    [0.060 * COAST_K, 122, 120, 116],  // apron and roads
    [0.085 * COAST_K, 140, 134, 112],  // cleared ground
    [0.200 * COAST_K,  92, 104,  74],  // coastal scrub
    [0.255 * COAST_K, 176, 164, 132],  // dune and beach
    [0.300 * COAST_K,  74, 128, 138],  // shallows
    [0.560 * COAST_K,  36,  78, 108],  // shelf
    [1.000,            22,  52,  84]   // open water
  ];

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x - half) / half, dy = (y - half) / half;
      const r = Math.sqrt(dx * dx + dy * dy) * 0.5;

      let i = 0;
      while (i < BANDS.length - 1 && r > BANDS[i][0]) i++;
      const band = BANDS[i];
      const next = BANDS[Math.min(i + 1, BANDS.length - 1)];
      // Cross-fade into the next band over the outer quarter of this one,
      // so no boundary reads as a drawn circle from altitude.
      const inner = i > 0 ? BANDS[i - 1][0] : 0;
      const span = Math.max(1e-4, band[0] - inner);
      const f = smoothstep(band[0] - span * 0.25, band[0], r);
      const R = lerp(band[1], next[1], f);
      const G = lerp(band[2], next[2], f);
      const B = lerp(band[3], next[3], f);

      // Break the bands up: coarse blotching plus fine grain.
      const n = (vnoise(x * 0.055 + y * 0.31) * 0.6 + vnoise(x * 0.21 - y * 0.09) * 0.4) * 26;
      const grain = (Math.random() - 0.5) * 11;

      const o = (y * N + x) * 4;
      d[o]     = clamp(R + n + grain, 0, 255);
      d[o + 1] = clamp(G + n * 0.9 + grain, 0, 255);
      d[o + 2] = clamp(B + n * 0.7 + grain, 0, 255);
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function makeConcreteTexture() {
  const N = 512;
  const { c, g } = makeCanvas(N);
  const img = g.createImageData(N, N);
  const d = img.data;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // Aggregate: three noise scales stacked, plus per-pixel grit.
      const n = vnoise(x * 0.09 + y * 0.53) * 16 +
                vnoise(x * 0.31 - y * 0.17) * 10 +
                vnoise(x * 1.7 + y * 2.3) * 6 +
                (Math.random() - 0.5) * 14;
      const v = clamp(139 + n, 0, 255);
      const o = (y * N + x) * 4;
      d[o] = v; d[o + 1] = v * 0.99; d[o + 2] = v * 0.95; d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  // Expansion joints on a 128 px grid, drawn slightly soft.
  g.strokeStyle = 'rgba(58,56,54,0.55)';
  g.lineWidth = 2;
  for (let i = 0; i <= N; i += 128) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, N); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(N, i); g.stroke();
  }
  // A few oil and scorch stains so the tiling does not read as a grid.
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * N, y = Math.random() * N, r = rand(8, 46);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(40,36,33,0.30)');
    grad.addColorStop(1, 'rgba(40,36,33,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  return c;
}

const coast = new THREE.Mesh(
  new THREE.CircleGeometry(COAST_R, 160),
  new THREE.MeshLambertMaterial({ map: asTexture(makeCoastTexture()) })
);
coast.rotation.x = -Math.PI / 2;
coast.position.y = -0.6;
coast.receiveShadow = false;
scene.add(coast);

const concrete = new THREE.Mesh(
  new THREE.PlaneGeometry(900, 900),
  new THREE.MeshStandardMaterial({
    map: asTexture(makeConcreteTexture(), 45), roughness: 0.94, metalness: 0.0
  })
);
concrete.material.map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
concrete.rotation.x = -Math.PI / 2;
concrete.receiveShadow = true;
scene.add(concrete);

/* Blast scorch around the trench: a soft alpha decal lifted 2 cm off the
   deck so it never z-fights with the concrete. */
(function addScorch() {
  const { c, g } = makeCanvas(256);
  const grad = g.createRadialGradient(128, 128, 10, 128, 128, 126);
  grad.addColorStop(0.00, 'rgba(18,16,15,0.86)');
  grad.addColorStop(0.45, 'rgba(30,27,24,0.52)');
  grad.addColorStop(1.00, 'rgba(40,36,32,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
  const decal = new THREE.Mesh(
    new THREE.CircleGeometry(78, 64),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.9 })
  );
  decal.rotation.x = -Math.PI / 2;
  decal.position.y = 0.02;
  decal.renderOrder = 1;
  scene.add(decal);
})();
