/* -- 9 -- flight dynamics ---------------------------------------------
   A continuous two-dimensional integration in the launch plane:
   downrange (world +X) and altitude (world +Y). At every step

       m(t)      = dry + remaining propellant
       T(h)      = throttle * lerp(T_vac, T_sl, p(h)/p0)
       mdot      = T / (Isp * g0)
       D         = 1/2 * rho(h) * v^2 * Cd(M) * A
       a         = (T * u_thrust - D * v_hat) / m - g(h) * u_up

   integrated with semi-implicit Euler on a fixed 1/120 s step, so the
   trajectory is identical whatever framerate the browser manages.     */

const IGNITION_T = -2.0;     // engine start, relative to release
const PITCH_T    = 12.0;     // start of the pitch programme
const MAX_PITCH  = 1.396;    // 80 degrees from vertical

const FL = {
  running: false, t: -10,
  alt: 0, down: 0, vx: 0, vy: 0,
  pitch: 0, roll: 0,
  mass: P.m0, prop1: P.m1_prop, prop2: P.m2_prop,
  throttle: 0, thrust: 0,
  q: 0, qmax: 0, mach: 0, gLoad: 0, vmag: 0,
  stage: 1,                  // 1 = booster, 0 = coasting between, 2 = upper
  fairingOn: true,
  fired: Object.create(null),
  mecoT: null, sepT: null
};

/* Free-flying debris (the spent booster, the fairing halves) gets a tiny
   ballistic sub-simulation of its own. */
const debris = [];

function currentMass() {
  let m = P.payload + P.m2_dry + FL.prop2;
  if (FL.fairingOn) m += P.fairing;
  if (FL.stage !== 2) m += P.m1_dry + FL.prop1;
  return m;
}

function fireEvent(key, label, hot) {
  if (FL.fired[key]) return;
  FL.fired[key] = FL.t;
  showCallout(label, hot);
  markSequence(key);
}

function step(dt) {
  if (!FL.running) return;
  FL.t += dt;

  const alt = FL.alt;
  const p   = pressure(alt);
  const rho = density(alt);
  const pr  = p / P.p0;                    // ambient pressure ratio
  const g   = gravity(alt);

  /* --- propulsion --------------------------------------------------- */
  let th = 0, Tfull = 0, isp = 1;

  if (FL.stage === 1 && FL.prop1 > 0) {
    Tfull = lerp(P.T1_vac, P.T1_sl, pr);   // thrust rises as ambient falls
    isp   = lerp(P.isp1_vac, P.isp1_sl, pr);
    if (FL.t >= IGNITION_T) {
      if (FL.t < 0) {
        // Ignition transient: chambers come up over ~1.3 s and the stack
        // is held on the clamps while the computer confirms all nine.
        th = clamp((FL.t - IGNITION_T) / 1.3, 0, 1) * (0.96 + 0.04 * fbm(FL.t * 11));
        if (!FL.fired.ignition) fireEvent('ignition', 'Ignition', true);
      } else {
        th = tableLookup(THROTTLE_TABLE, FL.t);
      }
    }
  } else if (FL.stage === 2 && FL.prop2 > 0 && FL.fired.ses1) {
    Tfull = P.T2_vac;
    isp   = P.isp2_vac;
    th    = 1;
  }

  FL.mass = currentMass();

  /* Closed-loop load relief: hold axial acceleration under G_LIMIT by
     backing the throttle off as the tanks drain. This is what reproduces
     the real throttle-down in the last half-minute before MECO. */
  if (FL.t > 0 && Tfull > 0 && th > 0) {
    const thG = (FL.mass * P.G_LIMIT * g) / Tfull;
    th = clamp(Math.min(th, Math.max(0.55, thG)), 0, 1);
  }

  const T = Tfull * th;
  FL.throttle = th;
  FL.thrust = T;

  if (T > 0) {
    const mdot = T / (isp * P.g0);
    if (FL.stage === 1) {
      FL.prop1 = Math.max(0, FL.prop1 - mdot * dt);
      if (FL.prop1 === 0) meco();
    } else {
      FL.prop2 = Math.max(0, FL.prop2 - mdot * dt);
      if (FL.prop2 === 0) fireEvent('seco', 'SECO-1  -  orbit', false);
    }
  }

  /* --- aerodynamics -------------------------------------------------- */
  const v = Math.hypot(FL.vx, FL.vy);
  FL.vmag = v;
  FL.mach = v / tableLookup(SOS_TABLE, alt);
  FL.q = 0.5 * rho * v * v;
  const A = FL.fairingOn ? P.A_fair : P.A_core;
  const D = FL.q * tableLookup(CD_TABLE, FL.mach) * A;

  if (FL.q > FL.qmax) {
    FL.qmax = FL.q;
  } else if (FL.qmax > 20000 && FL.t > 40) {
    // The peak has passed: q is falling because density is dropping
    // faster than v^2 is rising.
    fireEvent('maxq', 'Max Q', false);
  }

  /* --- guidance -------------------------------------------------------
     Vertical until the pitch programme, then a gravity turn: thrust is
     held along the velocity vector so no side force is needed and gravity
     alone bends the trajectory over. The decaying bias term stands in for
     the closed-loop steering that shapes the real profile.             */
  if (FL.t < PITCH_T) {
    FL.pitch = 0;
  } else if (FL.stage !== 0) {
    const bias = 0.092 * Math.exp(-(FL.t - PITCH_T) / 48);
    const wanted = clamp(Math.atan2(FL.vx, Math.max(FL.vy, 1)) + bias, 0, MAX_PITCH);
    FL.pitch = damp(FL.pitch, wanted, 2.4, dt);
    if (FL.t > PITCH_T + 0.1) fireEvent('pitch', 'Pitch and roll program', false);
  }

  /* --- integrate ------------------------------------------------------ */
  const m = FL.mass;
  const sp = Math.sin(FL.pitch), cp = Math.cos(FL.pitch);
  const vhx = v > 0.01 ? FL.vx / v : 0, vhy = v > 0.01 ? FL.vy / v : 0;

  const ax = (T * sp - D * vhx) / m;
  const ay = (T * cp - D * vhy) / m - g;

  FL.gLoad = Math.hypot(T * sp - D * vhx, T * cp - D * vhy) / m / P.g0;

  if (FL.t < 0) {
    // Held on the clamps: the mount takes the whole load.
    FL.vx = FL.vy = 0;
    FL.gLoad = 0;
  } else {
    if (!FL.fired.liftoff) fireEvent('liftoff', 'Liftoff', true);
    FL.vx += ax * dt;
    FL.vy += ay * dt;
    FL.down += FL.vx * dt;
    FL.alt  += FL.vy * dt;
    if (FL.alt < 0) { FL.alt = 0; FL.vy = Math.max(0, FL.vy); }
  }

  // Slow roll about the body axis once clear of the tower.
  if (FL.t > PITCH_T) FL.roll += dt * 0.055;

  /* --- flight events -------------------------------------------------- */
  if (FL.mecoT !== null) {
    if (FL.stage === 0 && FL.t > FL.mecoT + 3.5) separate();
    if (FL.sepT !== null) {
      if (!FL.fired.ses1 && FL.t > FL.sepT + 3.0) {
        FL.stage = 2;
        fireEvent('ses1', 'Second engine start', true);
      }
      if (FL.fairingOn && FL.t > FL.sepT + 34) deployFairing();
    }
  }

  stepDebris(dt);
}

function meco() {
  FL.stage = 0;
  FL.mecoT = FL.t;
  FL.throttle = 0;
  fireEvent('meco', 'MECO', true);
}

/* Stage separation. The booster is detached with Object3D.attach(), which
   re-parents it while preserving its world transform, then flown on its
   own ballistic state with a slow tumble. */
function separate() {
  if (FL.sepT !== null) return;
  FL.sepT = FL.t;

  scene.attach(stage1);
  debris.push({
    obj: stage1,
    v: new Vector3(FL.vx - Math.cos(FL.pitch) * 1.2, FL.vy - Math.sin(FL.pitch) * 0.4, 0),
    spin: new Vector3(0.004, 0.02, 0.09)
  });

  // Pneumatic pushers: a short cold-gas burst between the two stages.
  const base = vehicle.localToWorld(new Vector3(0, V.INTER_TOP, 0));
  SP.span = 1.6; SP.size = 1.4; SP.grow = 6; SP.alpha = 0.5;
  SP.drag = 0.7; SP.buoy = 0; SP.heat = 0; SP.cool = 3;
  for (let i = 0; i < 160; i++) {
    const a = Math.random() * TAU, s = rand(6, 26);
    exhaust.spawn(base.x + Math.cos(a) * 1.5, base.y, base.z + Math.sin(a) * 1.5,
                  FL.vx + Math.cos(a) * s, FL.vy + rand(-6, 6), Math.sin(a) * s);
  }

  fireEvent('sep', 'Stage separation', false);
  FL.stage = 0;   // coasting until SES-1 sets it to 2
}

function deployFairing() {
  FL.fairingOn = false;
  for (let i = 0; i < 2; i++) {
    const half = fairingHalves[i];
    scene.attach(half);
    const s = i === 0 ? -1 : 1;
    debris.push({
      obj: half,
      v: new Vector3(FL.vx, FL.vy + 1.5, s * 7.5),
      spin: new Vector3(s * 0.55, 0.05, 0.02)
    });
  }
  fireEvent('fairing', 'Fairing deploy', false);
}

function stepDebris(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    const g = gravity(Math.max(0, d.obj.position.y));
    d.v.y -= g * dt;
    d.obj.position.addScaledVector(d.v, dt);
    d.obj.rotation.x += d.spin.x * dt;
    d.obj.rotation.y += d.spin.y * dt;
    d.obj.rotation.z += d.spin.z * dt;
    // Retire anything that has fallen far behind the active vehicle.
    if (d.obj.position.y < -400 || FL.alt - d.obj.position.y > 30000) {
      scene.remove(d.obj);
      debris.splice(i, 1);
    }
  }
}

/* --- pad hardware animation ------------------------------------------ */
function updatePad(dt) {
  // Hold-down clamps swing clear the instant the count reaches zero.
  const rel = clamp((FL.t - 0.0) / 0.35, 0, 1);
  for (let i = 0; i < clamps.length; i++) clamps[i].rotation.z = -rel * 1.25;

  // Umbilical arms retract just before release.
  const ret = clamp((FL.t + 0.4) / 1.6, 0, 1);
  for (const u of umbilicals) {
    u.position.x = 1.35 - ret * 2.8;
    u.rotation.z = -ret * 0.52;
  }

  // The transporter-erector nods back off the vehicle, then tips to 45.
  let tilt = 0;
  if (FL.t > 0.4) tilt = smoothstep(0.4, 3.0, FL.t) * 0.05;
  if (FL.t > 6)   tilt = 0.05 + smoothstep(6, 28, FL.t) * 0.73;
  strongback.rotation.z = tilt;
}

/* --- the vehicle's world transform ----------------------------------- */
const AXIS_Y = new Vector3(0, 1, 0), AXIS_Z = new Vector3(0, 0, 1);
const _qp = new Quaternion(), _qr = new Quaternion();

function placeVehicle(now) {
  // The stack's origin is its engine gimbal plane, which rests on the
  // launch mount deck, so world height is altitude plus the deck.
  vehicle.position.set(FL.down, FL.alt + PAD_DECK, 0);

  // Structural shudder while the engines are up and the clamps still hold:
  // three octaves of value noise, scaled by thrust.
  if (FL.t > IGNITION_T && FL.t < 1.2) {
    const s = FL.throttle * (FL.t < 0 ? 0.055 : 0.03);
    vehicle.position.x += fbm(now * 31) * s;
    vehicle.position.z += fbm(now * 27 + 40) * s;
    vehicle.position.y += fbm(now * 37 + 90) * s * 0.5;
  }

  // Pitch about world Z, then roll about the vehicle's OWN axis. Composing
  // quaternions (rather than setting two Euler angles) is what keeps the
  // roll a roll instead of turning into a yaw once the stack is pitched.
  _qp.setFromAxisAngle(AXIS_Z, -FL.pitch);
  _qr.setFromAxisAngle(AXIS_Y, FL.roll);
  vehicle.quaternion.copy(_qp).multiply(_qr);
}

/* --- exhaust emission ------------------------------------------------- */
const _ax = new Vector3(), _rt = new Vector3(), _fw = new Vector3(), _ep = new Vector3();

function emitExhaust(dt, now) {
  const pr = pressure(FL.alt) / P.p0;
  const vac = 1 - pr;                       // 0 at sea level, 1 in vacuum
  const th = FL.throttle;

  jetUniforms.uTime.value = now;
  jetUniforms.uAmb.value = pr;

  if (th <= 0.01 || (FL.stage !== 1 && FL.stage !== 2)) {
    jetUniforms.uThrottle.value = damp(jetUniforms.uThrottle.value, 0, 12, dt);
    flashSprite.scale.setScalar(damp(flashSprite.scale.x, 0.01, 12, dt));
    return;
  }

  const isUpper = FL.stage === 2;
  _ax.set(0, 1, 0).applyQuaternion(vehicle.quaternion);
  _rt.set(1, 0, 0).applyQuaternion(vehicle.quaternion);
  _fw.set(0, 0, 1).applyQuaternion(vehicle.quaternion);

  // Engine plane in world space.
  const localY = isUpper ? vehicle.userData.mvacY : 0.1;
  _ep.copy(vehicle.position).addScaledVector(_ax, localY);

  /* The coherent core. A Merlin's real exhaust leaves at about 2.8 km/s;
     the particles are flown at a small fraction of that so a plume still
     exists between frames - the jet mesh is what carries the impression
     of speed. */
  const coreLen = isUpper ? lerp(26, 52, vac) : lerp(22, 52, vac) * (0.55 + 0.45 * th);
  const coreW   = isUpper ? lerp(1.4, 4.2, vac) : lerp(1.5, 4.0, vac);
  const flick = 1 + fbm(now * 26) * 0.10;
  jet.position.set(0, localY - coreLen * 0.5 * flick, 0);
  jet.scale.set(coreW * flick, coreLen * flick, coreW * flick);
  jetUniforms.uThrottle.value = damp(jetUniforms.uThrottle.value, th * (isUpper ? 0.55 : 1), 10, dt);

  flashSprite.position.set(0, localY, 0);
  flashSprite.scale.setScalar(damp(flashSprite.scale.x,
    (isUpper ? 6 : lerp(7, 17, vac)) * th, 9, dt));

  /* --- particles ----------------------------------------------------- */
  const rate = (isUpper ? 170 : 780) * th * quality.spawn;
  exhaust._acc += rate * dt;
  let n = Math.min(Math.floor(exhaust._acc), 300);
  exhaust._acc -= n;
  if (n <= 0) return;

  // Jet speed and cone angle. A rocket exhaust is tightly collimated in
  // thick air and blooms enormously once there is nothing to confine it.
  const speed  = (isUpper ? 210 : 105) * (0.55 + 0.45 * th) * lerp(1, 2.4, vac);
  const spread = isUpper ? 0.30 : lerp(0.06, 0.40, vac);
  const bellR  = isUpper ? 1.3 : 1.45;

  SP.span  = (isUpper ? 1.5 : 0.55) + Math.random() * (isUpper ? 1.2 : 0.45);
  SP.alpha = isUpper ? 0.5 : 0.95;
  SP.drag  = isUpper ? 0.25 : lerp(1.7, 0.5, vac);
  SP.buoy  = 0;
  SP.heat  = 1;
  SP.cool  = isUpper ? 0.55 : lerp(2.1, 0.7, vac);

  for (let k = 0; k < n; k++) {
    // Spawn across the engine cluster, densest on the centreline.
    const a = Math.random() * TAU;
    const r = Math.sqrt(Math.random()) * bellR;
    const ox = Math.cos(a) * r, oz = Math.sin(a) * r;

    const px = _ep.x + _rt.x * ox + _fw.x * oz;
    const py = _ep.y + _rt.y * ox + _fw.y * oz;
    const pz = _ep.z + _rt.z * ox + _fw.z * oz;

    // Velocity: the vehicle's own motion, plus the jet down the body axis,
    // plus a lateral component that opens the cone.
    const sx = rand(-1, 1) * spread * speed;
    const sz = rand(-1, 1) * spread * speed;
    const jv = speed * rand(0.78, 1.15);

    SP.size = (isUpper ? 2.4 : lerp(1.1, 2.6, vac)) * rand(0.75, 1.3);
    SP.grow = isUpper ? 9 : lerp(5.5, 14, vac);

    exhaust.spawn(px, py, pz,
      FL.vx - _ax.x * jv + _rt.x * sx + _fw.x * sz,
      FL.vy - _ax.y * jv + _rt.y * sx + _fw.y * sz,
             - _ax.z * jv + _rt.z * sx + _fw.z * sz);
  }

  /* Deluge steam: while the stack is still on the mount, the sound
     suppression water flashes to steam at both trench mouths. */
  if (FL.t > IGNITION_T && FL.alt < 90) {
    const fade = 1 - smoothstep(0, 90, FL.alt);
    SP.span = 5 + Math.random() * 5; SP.alpha = 0.52; SP.drag = 0.55;
    SP.buoy = 3.4; SP.heat = 0; SP.cool = 3; SP.grow = 5.4;
    const m = Math.floor(10 * fade * th * quality.spawn);
    for (let k = 0; k < m; k++) {
      const s = Math.random() < 0.5 ? -1 : 1;
      SP.size = rand(3.5, 6.0);
      exhaust.spawn(s * rand(11, 19), rand(1.5, 4), rand(-7, 7),
                    s * rand(10, 28), rand(4, 16), rand(-9, 9));
    }
  }
}

/* --- engine lighting --------------------------------------------------
   The point light attached to the exhaust is the only dynamic shadow
   caster besides the sun, and a shadow-casting point light is six render
   passes, so it is switched off the moment the vehicle is too high for
   those shadows to land on anything. */
function updateEngineLight(now) {
  const th = FL.throttle;
  if (th <= 0.01) {
    engineLight.intensity = 0;
    glowLight.intensity = 0;
    engineLight.castShadow = false;
    renderer.toneMappingExposure = 1.0;
    return;
  }
  _ax.set(0, 1, 0).applyQuaternion(vehicle.quaternion);
  const localY = FL.stage === 2 ? vehicle.userData.mvacY : 0.1;
  _ep.copy(vehicle.position).addScaledVector(_ax, localY - 5);

  // Combustion flicker: two noise octaves at different rates so it reads
  // as turbulence rather than a strobe.
  const flick = 1 + fbm(now * 34) * 0.16 + fbm(now * 8.5) * 0.09;

  engineLight.position.copy(_ep);
  glowLight.position.copy(_ep);

  const near = smoothstep(2600, 260, FL.alt);      // 1 near the pad, 0 high up
  engineLight.intensity = 5200 * th * flick * near;
  glowLight.intensity   = 2600 * th * flick * near;
  engineLight.castShadow = FL.alt < 300 && quality.engineShadow;

  // A touch of exposure lift at ignition so the frame blooms.
  const bloom = th * smoothstep(3200, 0, FL.alt);
  renderer.toneMappingExposure = 1.0 + bloom * 0.22;

  // Once the vehicle and the strongback have both left the sun's shadow
  // volume, nothing inside it moves again - so the map is rendered one
  // last time and then frozen, which retires a 2048px pass per frame.
  if (FL.alt > 4000 && renderer.shadowMap.autoUpdate) {
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
  }
}
