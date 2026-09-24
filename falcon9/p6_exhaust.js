/* -- 8 -- exhaust -----------------------------------------------------
   One particle system carries both the combusting plume and the cold
   smoke it becomes. That is possible because the material blends with
   PREMULTIPLIED ALPHA:

       dst = src.rgb + dst.rgb * (1 - src.a)

   A particle that writes a bright colour with a near-zero alpha adds to
   the frame like an additive fire sprite; one that writes a dark colour
   with a full alpha composites over it like ordinary smoke. Both live in
   a single draw call, and a plume particle can cross from one behaviour
   to the other simply by decaying its `heat` - which is exactly what
   happens when exhaust strikes the flame deflector.

   Everything is held in flat typed arrays and recycled through a ring
   buffer, so a steady-state plume allocates nothing per frame.        */

const PARTICLE_MAX = 11000;

const exhaustMat = new THREE.ShaderMaterial({
  uniforms: { uScale: { value: 800 } },
  transparent: true,
  depthWrite: false,
  depthTest: true,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendEquation: THREE.AddEquation,
  vertexShader: `
    precision highp float;
    uniform float uScale;
    attribute float aSize;   // world-space diameter, metres
    attribute float aAlpha;
    attribute float aHeat;   // 1 = combusting, 0 = cold smoke
    attribute float aT;      // normalised age, 0..1
    attribute float aSeed;
    varying vec3  vColor;
    varying float vAlpha, vOpaque, vSeed, vHeat;

    void main(){
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;

      // Perspective point sizing. A sprite d metres across sitting z metres
      // down the view axis covers d * uScale / z pixels, where
      // uScale = viewportHeight / (2 * tan(fov / 2)).
      gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.001), 1.0, 620.0);

      // Colour interpolation. Combustion products run white-hot, through
      // straw, to orange as they cool; entrained smoke starts as bright
      // condensation and greys out as it expands and thins.
      vec3 fire  = mix(vec3(1.00, 0.97, 0.88), vec3(1.00, 0.40, 0.09), pow(aT, 0.62));
      vec3 smoke = mix(vec3(0.95, 0.94, 0.93), vec3(0.29, 0.29, 0.32), pow(aT, 0.55));
      vColor = mix(smoke, fire * (1.5 + 2.6 * (1.0 - aT)), aHeat);

      vAlpha  = aAlpha;
      vOpaque = mix(1.0, 0.05, aHeat);   // fire barely occludes, smoke fully does
      vSeed   = aSeed;
      vHeat   = aHeat;
    }`,
  fragmentShader: `
    precision highp float;
    varying vec3  vColor;
    varying float vAlpha, vOpaque, vSeed, vHeat;

    float h2(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
    float n2(vec2 p){
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h2(i), h2(i + vec2(1,0)), f.x),
                 mix(h2(i + vec2(0,1)), h2(i + vec2(1,1)), f.x), f.y);
    }

    void main(){
      vec2 uv = gl_PointCoord - 0.5;
      float r = length(uv) * 2.0;
      if (r > 1.0) discard;

      // Radial falloff. Fire keeps a tight bright core; smoke is broader.
      float a = pow(1.0 - r, mix(1.15, 3.0, vHeat));

      // Two octaves of value noise, seeded per particle, tear the perfect
      // circle into a puff. Fire is left smooth so the jet stays coherent.
      float n = n2(uv * 5.0 + vSeed * 37.0) * 0.62 + n2(uv * 12.0 - vSeed * 13.0) * 0.38;
      a *= mix(0.60 + 0.62 * n, 1.0, vHeat);
      a *= vAlpha;
      if (a <= 0.003) discard;

      gl_FragColor = vec4(vColor * a, a * vOpaque);
    }`
});

/* Shared spawn parameters. Set the fields, then call spawn() - this keeps
   the emitters allocation-free in the inner loop. */
const SP = { span: 1, size: 1, grow: 1, alpha: 1, drag: 1, buoy: 0, heat: 1, cool: 2 };

class Exhaust {
  constructor(max) {
    this.max = max;
    this.cursor = 0;
    this.live = 0;
    this._acc = 0;

    this.pos    = new Float32Array(max * 3);
    this.aSize  = new Float32Array(max);
    this.aAlpha = new Float32Array(max);
    this.aHeat  = new Float32Array(max);
    this.aT     = new Float32Array(max);
    this.aSeed  = new Float32Array(max);

    this.vel    = new Float32Array(max * 3);
    this.life   = new Float32Array(max);
    this.span   = new Float32Array(max);
    this.size0  = new Float32Array(max);
    this.grow   = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.drag   = new Float32Array(max);
    this.buoy   = new Float32Array(max);
    this.cool   = new Float32Array(max);

    for (let i = 0; i < max; i++) this.aSeed[i] = Math.random();

    const g = new THREE.BufferGeometry();
    const A = (arr, n) => new THREE.BufferAttribute(arr, n);
    g.setAttribute('position', A(this.pos, 3));
    g.setAttribute('aSize',  A(this.aSize, 1));
    g.setAttribute('aAlpha', A(this.aAlpha, 1));
    g.setAttribute('aHeat',  A(this.aHeat, 1));
    g.setAttribute('aT',     A(this.aT, 1));
    g.setAttribute('aSeed',  A(this.aSeed, 1));
    this.geo = g;

    this.points = new THREE.Points(g, exhaustMat);
    this.points.frustumCulled = false;   // positions move; the bounds go stale
    this.points.renderOrder = 3;
    scene.add(this.points);
  }

  spawn(x, y, z, vx, vy, vz) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.max;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.life[i] = this.span[i] = SP.span;
    this.size0[i] = SP.size;
    this.grow[i]  = SP.grow;
    this.alpha0[i] = SP.alpha;
    this.drag[i]  = SP.drag;
    this.buoy[i]  = SP.buoy;
    this.cool[i]  = SP.cool;
    this.aHeat[i] = SP.heat;
    this.aSize[i] = SP.size;
    this.aT[i] = 0;
    this.aAlpha[i] = 0;
    this.aSeed[i] = Math.random();
  }

  /* One integration step for every live particle.
     ctx.impactY  - height of the surface the jet is striking
     ctx.padFlow  - 1 while the flow is being turned by the trench        */
  update(dt, ctx) {
    const { pos, vel, life, span, size0, grow, alpha0, drag, buoy, cool,
            aSize, aAlpha, aHeat, aT, aSeed } = this;
    const impactY = ctx.impactY, padFlow = ctx.padFlow;
    let live = 0;

    for (let i = 0; i < this.max; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) { aAlpha[i] = 0; continue; }
      live++;

      const i3 = i * 3;
      // Exponential drag keeps the integration stable at any step size:
      // v(t+dt) = v(t) * e^(-k dt), which can never overshoot through zero.
      const k = Math.exp(-drag[i] * dt);
      vel[i3] *= k;
      vel[i3 + 1] = (vel[i3 + 1] + buoy[i] * dt) * k;   // hot gas rises
      vel[i3 + 2] *= k;

      pos[i3]     += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;

      // --- impingement -------------------------------------------------
      // A still-burning particle that reaches the deflector has its axial
      // momentum turned into a radial sheet, and becomes smoke: this is
      // what generates the pad cloud, rather than a second emitter.
      if (pos[i3 + 1] < impactY && aHeat[i] > 0.02) {
        const dx = pos[i3], dz = pos[i3 + 2];
        const speed = Math.hypot(vel[i3], vel[i3 + 1], vel[i3 + 2]) * 0.52 + 16;
        let ox, oz;
        if (padFlow > 0.5) {
          // The trench is a ridge running along Z, so the flow leaves
          // along +/- X. Which side is fixed per particle by its seed.
          ox = aSeed[i] < 0.5 ? -1 : 1;
          oz = (aSeed[i] * 7.0 % 1.0 - 0.5) * 0.7;
        } else {
          const m = Math.hypot(dx, dz) || 1e-3;
          ox = dx / m; oz = dz / m;
        }
        const m2 = Math.hypot(ox, oz);
        ox /= m2; oz /= m2;

        vel[i3]     = ox * speed;
        vel[i3 + 1] = speed * 0.26;
        vel[i3 + 2] = oz * speed;
        pos[i3 + 1] = impactY + 0.5;

        aHeat[i]  = 0.20;               // still glowing at the trench mouth
        cool[i]   = 2.4;
        life[i]   = span[i] = 7 + aSeed[i] * 9;
        size0[i]  = aSize[i] * 1.6;
        grow[i]   = 3.4 + aSeed[i] * 4.6;
        alpha0[i] = 0.55;
        drag[i]   = 0.7;
        buoy[i]   = 1.5;
      }

      aHeat[i] = Math.max(0, aHeat[i] - cool[i] * dt);

      const age = span[i] - life[i];
      const t = age / span[i];
      aT[i] = t;
      aSize[i] = size0[i] + grow[i] * age;

      // Fire flares and dies fast; smoke fades in, holds, then thins out.
      let f;
      if (aHeat[i] > 0.35) f = Math.min(1, age * 22) * (1 - t) * (1 - t);
      else                 f = Math.min(1, age * 5) * Math.pow(1 - t, 1.25);
      aAlpha[i] = alpha0[i] * f;
    }

    this.live = live;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.attributes.aHeat.needsUpdate = true;
    this.geo.attributes.aT.needsUpdate = true;
    this.geo.attributes.aSeed.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.aAlpha.fill(0);
    this.cursor = 0;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }
}

const exhaust = new Exhaust(PARTICLE_MAX);

/* --- the visible jet -------------------------------------------------
   Particles alone read as smoke, never as a supersonic jet. A single
   cone drawn additively supplies the coherent core, and its shader draws
   the standing shock cells - the Mach diamonds - which only form while
   ambient pressure is high enough for the jet to be over-expanded.    */
const jetUniforms = {
  uTime:     { value: 0 },
  uThrottle: { value: 0 },
  uAmb:      { value: 1 }      // ambient pressure ratio p(h) / p0
};

const jet = new THREE.Mesh(
  new THREE.CylinderGeometry(0.85, 1.9, 1, 28, 1, true),
  new THREE.ShaderMaterial({
    uniforms: jetUniforms,
    transparent: true, depthWrite: false, fog: false,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: `
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      precision highp float;
      uniform float uTime, uThrottle, uAmb;
      varying vec2 vUv;
      void main(){
        // t = 0 at the nozzle plane (the top of the cone), 1 at the tail.
        float t = 1.0 - vUv.y;

        // Shock cells. Their spacing grows downstream as the jet expands,
        // hence the pow(); they exist only while the jet is confined by
        // ambient pressure, hence the uAmb factor.
        float cells = sin(pow(t, 0.72) * 30.0 - uTime * 2.0);
        float diamonds = smoothstep(0.45, 1.0, cells) * uAmb;

        float body = pow(max(1.0 - t, 0.0), 1.7);
        float a = (body * 0.5 + diamonds * body * 1.5) * uThrottle;

        vec3 c = mix(vec3(1.0, 0.52, 0.16), vec3(0.88, 0.94, 1.0),
                     clamp(diamonds * 0.85 + body * 0.30, 0.0, 1.0));
        gl_FragColor = vec4(c * a, a);
      }`
  })
);
jet.frustumCulled = false;
jet.renderOrder = 2;
vehicle.add(jet);

/* A bright bloom right at the engine plane, so the source of the light
   reads as a source and not as a hole in the smoke. */
const flashSprite = (function () {
  const { c, g } = makeCanvas(128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0.00, 'rgba(255,248,230,1)');
  grad.addColorStop(0.22, 'rgba(255,190,110,0.72)');
  grad.addColorStop(0.60, 'rgba(255,120,50,0.20)');
  grad.addColorStop(1.00, 'rgba(255,90,30,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, blending: THREE.AdditiveBlending, depthWrite: false,
    transparent: true, fog: false
  }));
  s.renderOrder = 4;
  vehicle.add(s);
  return s;
})();
