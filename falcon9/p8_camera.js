/* -- 10 -- camera director --------------------------------------------
   Five framings plus an auto-director that cuts between them. A shot
   only has to publish where the camera stands, what it points at and how
   much of the frame the vehicle should fill. Everything that keeps the
   shot watchable happens here, in one place:

     framing  the lens - or the standoff, for the shots that fly - is
              solved from the live size of the stack, so the whole
              vehicle and a length of flame sit inside the picture on any
              aspect ratio, portrait phone included
     lead     the desired framing's own motion is fed forward before the
              damping. A plain damped follow always trails a moving
              target by v/lambda, which at two kilometres a second is
              what walks the vehicle off the edge of the frame
     guard    once the damping and the shake have had their say the frame
              is measured again and the lens opened if anything has been
              pushed outside it
     shake    acoustic pressure off the plume, and airframe buffet for
              the camera that is bolted to the vehicle                  */

const quality = { spawn: 1, engineShadow: true, level: 2 };

const DEG = Math.PI / 180;
const WORLD_UP = new Vector3(0, 1, 0);
const FRAME_GUARD = 0.95;   // fraction of the half-frame the guard defends
const AFT_IN_SHOT = 0.55;   // how far up the body the rocketcam has to see

const CAM = {
  mode: 0,            // 0 = auto
  active: 1,
  last: -1,
  fov: 32,
  pos: new Vector3(72, 26, 88),
  target: new Vector3(0, 35, 0),
  orbitYaw: 0, orbitPitch: 0, orbitZoom: 1,

  dist: 0,                                  // solved standoff, flying shots
  guard: 0,                                 // degrees of lens the guard added
  clock: 0,                                 // last simulation time seen
  anchor: new Vector3()                     // where the vehicle was last frame
};

/* What the current shot wants. Filled in from scratch every frame. */
const SHOT = {
  pos: new Vector3(),     // where the camera stands (locked-off shots)
  aim: new Vector3(),     // what sits in the middle of the frame
  dir: new Vector3(),     // unit vector, aim -> eye
  fly: false,             // solve the standoff rather than the lens
  rides: false,           // the camera travels with the vehicle
  solve: true,            // measure the frame and size the lens to it
  wheel: 0,               // 0: the wheel scales the framing, 1: the standoff
  fov: 34, fill: 0.70, lo: 20, hi: 60,
  lam: 5, drift: 0,
  shakePos: 0.3, shakeRot: 0.6
};

const TSITE = new Vector3(-180, 12, 690);   // tracker site, chosen at the cut

const _sv = new Vector3(), _e = new Vector3(), _eye = new Vector3();
const _r = new Vector3(), _u = new Vector3(), _f = new Vector3(), _d = new Vector3();
const _boom = new Vector3(), _tmp = new Vector3();

/* --- acoustic delay line ---------------------------------------------
   The shake a distant camera feels is the sound pressure that left the
   engines r / 343 seconds ago, not the thrust right now. Twenty
   milliseconds per slot over ten seconds is plenty of resolution.     */
const ACO_N = 512, ACO_STEP = 0.02;
const acoustic = new Float32Array(ACO_N);
let acoIdx = 0, acoAcc = 0;

function pushAcoustic(dt, value) {
  acoAcc += dt;
  while (acoAcc >= ACO_STEP) {
    acoAcc -= ACO_STEP;
    acoIdx = (acoIdx + 1) % ACO_N;
    acoustic[acoIdx] = value;
  }
}
function acousticAt(delay) {
  const back = Math.min(ACO_N - 1, Math.max(0, Math.round(delay / ACO_STEP)));
  return acoustic[(acoIdx - back + ACO_N * 2) % ACO_N];
}

/* --- the subject ------------------------------------------------------
   What has to stay inside the frame. It is rebuilt every frame because
   the thing being filmed gets shorter twice: the booster goes at
   separation and the fairing goes thirty seconds later.               */
const SUB = {
  axis: new Vector3(),
  base: new Vector3(), top: new Vector3(), mid: new Vector3(),
  half: 35, rad: 4, plume: 0
};

function updateSubject() {
  SUB.axis.set(0, 1, 0).applyQuaternion(vehicle.quaternion);

  // Station lines of the live vehicle: engine plane to nose, then the
  // MVac bell to the nose, then the bare second stage and its payload.
  const b = FL.sepT !== null ? vehicle.userData.mvacY : 0;
  const t = FL.fairingOn ? V.TOP : V.S2_TOP;

  SUB.base.copy(vehicle.position).addScaledVector(SUB.axis, b);
  SUB.top .copy(vehicle.position).addScaledVector(SUB.axis, t);
  SUB.half = (t - b) * 0.5;
  SUB.rad  = (FL.fairingOn ? V.FAIR_R : V.R) + 1.6;

  // Plume length, mirroring what the exhaust actually draws: short and
  // collimated in thick air, blooming to fifty metres in vacuum.
  const vac = 1 - pressure(FL.alt) / P.p0;
  const th  = FL.throttle;
  SUB.plume = th > 0.02
    ? (FL.stage === 2 ? lerp(26, 52, vac) : lerp(22, 52, vac) * (0.55 + 0.45 * th))
    : 0;
}

/* The two points the framing has to hold, and the centre between them.
   In camera space a straight segment's screen offset is a ratio of two
   linear functions of the parameter, so it is monotone and its worst
   value is always at an end - sampling along the body would find
   nothing the ends do not already say.                                */
const FIT = [new Vector3(), new Vector3(), new Vector3()];
let FIT_N = 2;

function framePoints(plumeShare) {
  FIT[0].copy(SUB.base).addScaledVector(SUB.axis, -SUB.plume * plumeShare);
  FIT[1].copy(SUB.top);
  FIT_N = 2;
  return SUB.mid.addVectors(FIT[0], FIT[1]).multiplyScalar(0.5);
}

/* --- the framing solver -----------------------------------------------
   lookBasis builds the same right/up/forward three.js will build from
   camera.lookAt, and fitTan then reports the half-height of the picture,
   as a tangent, that just contains the subject. Both screen axes are
   tested against the aspect ratio, so a stack held upright on a phone is
   framed by its length and not by its width.                          */
let fitBehind = false;

function lookBasis(eye, aim) {
  _f.subVectors(aim, eye);
  if (_f.lengthSq() < 1e-8) _f.set(0, 0, -1); else _f.normalize();
  _r.crossVectors(_f, WORLD_UP);
  if (_r.lengthSq() < 1e-8) _r.set(1, 0, 0); else _r.normalize();
  _u.crossVectors(_r, _f);
}

function fitTan(eye) {
  const asp = Math.max(0.25, camera.aspect);
  let need = 0;
  fitBehind = false;
  for (let i = 0; i < FIT_N; i++) {
    _d.subVectors(FIT[i], eye);
    const z = _d.dot(_f);
    if (z < 1) { fitBehind = true; continue; }   // beside or behind the lens
    const y = (Math.abs(_d.dot(_u)) + SUB.rad) / z;
    const x = (Math.abs(_d.dot(_r)) + SUB.rad) / (z * asp);
    if (y > need) need = y;
    if (x > need) need = x;
  }
  return need > 0 ? need : 0.3;
}

/* --- the running order ------------------------------------------------
   Pad camera through tower clear, the ground tracker for the climb-out,
   then the aerial plate for the rest of the burn, with the onboard rig
   cut in over the two events worth seeing from the vehicle itself. Every
   branch covers one contiguous stretch of the count, so the director
   cannot flicker between two shots.                                   */
function autoPick() {
  const t = FL.t;
  if (FL.mecoT !== null && t > FL.mecoT - 3 && t < FL.mecoT + 12) return 4;
  if (FL.fired.fairing !== undefined && t < FL.fired.fairing + 11) return 4;
  if (t < 9) return 1;
  if (t < 34) return 2;
  return 3;
}

function updateCamera(dtReal, now) {
  /* Damping runs on simulation time. `now` is the simulation clock, so
     its advance already carries the time-rate multiplier - which is what
     holds the vehicle in the middle of the frame at 16x instead of
     leaving the camera to trail a kilometre behind it. */
  let dt = now - CAM.clock;
  CAM.clock = now;
  if (!(dt > 0)) dt = 0; else if (dt > 0.5) dt = 0.5;

  const mode = CAM.mode === 0 ? autoPick() : CAM.mode;
  /* The onboard rig moves from the interstage to the top of stage 2 at
     separation. That is a cut, not a camera flying up the vehicle. */
  const rig = mode === 4 ? (FL.sepT !== null ? 41 : 40) : mode;
  const cut = rig !== CAM.last;
  CAM.last = rig;
  CAM.active = mode;

  updateSubject();

  SHOT.fly = false; SHOT.rides = false; SHOT.solve = true; SHOT.drift = 0;
  SHOT.wheel = 0; SHOT.lam = 5; SHOT.lo = 20; SHOT.hi = 60;

  if (mode === 1) {
    /* --- PAD: a remote camera inside the perimeter. It cranes slowly up
       and around the mount while the lens opens to keep the stack, the
       deluge and the flame trench in one frame. */
    const k = smoothstep(-8, 30, FL.t);
    SHOT.aim.copy(framePoints(0.85));
    const az = 0.86 + k * 0.32, r = lerp(94, 124, k);
    SHOT.pos.set(Math.sin(az) * r, lerp(6.5, 34, k * k), Math.cos(az) * r);
    SHOT.fill = 0.72; SHOT.lo = 24; SHOT.hi = 82;
    SHOT.lam = 3.4; SHOT.drift = 0.05;
    SHOT.shakePos = 1.0; SHOT.shakeRot = 1.0;

  } else if (mode === 2) {
    /* --- TRACKER: a long lens on the ground, locked off on its tripod.
       The site is picked once, on the cut, from where the vehicle is at
       that moment: real range cameras hand off between stations rather
       than fly, and choosing the station at the cut is what stops the
       shot from ending as a dot in an empty sky. The lens is then solved
       so the stack holds a constant share of the frame, which is exactly
       what a tracking operator is doing by hand. */
    if (cut) {
      const reach = clamp(260 + FL.alt * 0.5, 260, 7000);
      TSITE.set(vehicle.position.x - reach * 0.34 - 150, 11, reach * 0.94 + 150);
    }
    SHOT.aim.copy(framePoints(0.8));
    SHOT.pos.copy(TSITE);
    SHOT.fill = 0.50; SHOT.lo = 1.6; SHOT.hi = 48;
    SHOT.lam = 6; SHOT.drift = 0.035;
    SHOT.shakePos = 0.12; SHOT.shakeRot = 1.5;

  } else if (mode === 3) {
    /* --- CHASE: an aerial plate holding station off the vehicle's
       flank. It eases round the body axis and drifts in elevation so the
       stack turns in view, and the standoff is solved rather than fixed:
       the old 52 m offset put a 70 m vehicle in a 37 m frame, which is
       why half the rocket used to be outside the picture. */
    SHOT.aim.copy(framePoints(0.42));
    const a = now * 0.055 + 0.6;
    // Near the ground the plate is held above the flank so it cannot be
    // flown through the terrain on its way round.
    const el = lerp(0.14 + Math.sin(now * 0.021) * 0.22, 0.34,
                    smoothstep(600, 60, FL.alt));
    const ce = Math.cos(el);
    SHOT.dir.set(Math.cos(a) * ce, Math.sin(el), Math.sin(a) * ce)
            .applyQuaternion(vehicle.quaternion);
    SHOT.fly = true; SHOT.rides = true;
    SHOT.fov = 34; SHOT.fill = 0.80; SHOT.lo = 24; SHOT.hi = 62;
    SHOT.lam = 4.5;
    SHOT.shakePos = 0.35; SHOT.shakeRot = 0.6;

  } else if (mode === 4) {
    /* --- ONBOARD: a fixed camera on a short boom, looking back down the
       vehicle at the engines, the plume and the ground falling away.
       Nothing is solved here - a rocketcam sees whatever the mount sees -
       but the boom is long enough, and the aim carried far enough past
       the axis, that the body fills one side of the frame instead of
       sitting just off the edge of it. */
    _boom.set(1, 0, 0).applyQuaternion(vehicle.quaternion);
    const flown = FL.sepT !== null;
    const mountH = flown ? V.S2_TOP - 1.5 : V.INTER_TOP - 1.0;
    const boom = V.R + (flown ? 2.2 : 3.2);
    const look = flown ? 40 : 46;
    SHOT.pos.copy(vehicle.position)
      .addScaledVector(SUB.axis, mountH).addScaledVector(_boom, boom);
    SHOT.aim.copy(vehicle.position)
      .addScaledVector(SUB.axis, mountH - look).addScaledVector(_boom, -boom * 0.3);

    /* A rocketcam frames whatever the mount sees, so the solver is only
       shown the part of the vehicle aft of the boom - what is level with
       the lens or above it is behind the shot by construction - and the
       lens is floored at the 62 degrees the mount is built around. It
       can open past that but never close inside it, which is what keeps
       the engine end in the picture on a frame as narrow as a phone held
       upright without touching the shot on a wide screen. */
    framePoints(0.45);
    FIT[1].copy(SUB.base);
    FIT[2].copy(SUB.base).addScaledVector(
      SUB.axis, (mountH - (flown ? vehicle.userData.mvacY : 0)) * AFT_IN_SHOT);
    FIT_N = 3;
    SUB.rad = V.R + 1.0;              // the fairing is above the mount
    SHOT.rides = true; SHOT.wheel = 1;
    SHOT.fov = 62; SHOT.fill = 0.86; SHOT.lo = 62; SHOT.hi = 92;
    SHOT.lam = 9;
    SHOT.shakePos = 0.5; SHOT.shakeRot = 0.9;

  } else {
    /* --- FREE: a plain orbit the viewer drives, framed by the same
       solver so the stack stays in the picture wherever it is dragged. */
    SHOT.aim.copy(framePoints(0.45));
    SHOT.dir.set(0.66, 0.34, 0.67).normalize();
    SHOT.fly = true; SHOT.rides = true;
    SHOT.fov = 36; SHOT.fill = 0.60; SHOT.lo = 26; SHOT.hi = 64;
    SHOT.lam = 4;
    SHOT.shakePos = 0.25; SHOT.shakeRot = 0.4;
  }

  /* An operator is never perfectly still. The wander is scaled by the
     subject's own length and applied before the lens is solved, so it
     reads as a human hand and can never walk the vehicle out of frame. */
  if (SHOT.drift > 0) {
    const w = SHOT.drift * SUB.half;
    SHOT.aim.x += fbm(now * 0.23) * w;
    SHOT.aim.y += fbm(now * 0.19 + 12) * w;
    SHOT.aim.z += fbm(now * 0.17 + 40) * w;
  }

  /* Fold every shot into one (aim, direction, distance) form so the
     viewer's drag and the solver only have to understand one thing. */
  let dist = CAM.dist;
  if (!SHOT.fly) {
    _e.subVectors(SHOT.pos, SHOT.aim);
    dist = _e.length();
    SHOT.dir.copy(_e).multiplyScalar(dist > 1e-6 ? 1 / dist : 0);
    if (SHOT.wheel) dist *= CAM.orbitZoom;    // a fixed lens backs off instead
  }

  /* Viewer look-around: yaw about world up, pitch as an elevation offset.
     The wheel scales how much of the frame the vehicle fills, so zooming
     never fights the solver the way moving the eye would. */
  if (CAM.orbitYaw || CAM.orbitPitch) {
    const yaw = Math.atan2(SHOT.dir.x, SHOT.dir.z) + CAM.orbitYaw;
    const pit = clamp(Math.asin(clamp(SHOT.dir.y, -1, 1)) + CAM.orbitPitch, -1.35, 1.40);
    const cp = Math.cos(pit);
    SHOT.dir.set(Math.sin(yaw) * cp, Math.sin(pit), Math.cos(yaw) * cp);
  }
  const fill = clamp(SHOT.wheel ? SHOT.fill : SHOT.fill / CAM.orbitZoom, 0.06, 0.95);

  let fovWant = SHOT.fov;
  if (SHOT.fly) {
    /* Solve the standoff. Angular size falls off as 1/distance, so one
       ratio step lands within a per cent and a second nails it; a cut
       runs the loop out so the shot opens already framed. */
    const want = Math.tan(clamp(SHOT.fov, SHOT.lo, SHOT.hi) * DEG * 0.5) * fill;
    const near = SUB.half * 1.2 + 8;
    if (!(dist > near)) dist = SUB.half * 6 + 60;
    for (let i = cut ? 6 : 2; i > 0; i--) {
      _eye.copy(SHOT.aim).addScaledVector(SHOT.dir, dist);
      lookBasis(_eye, SHOT.aim);
      let s = fitTan(_eye) / want;
      if (fitBehind) s = Math.max(s, 1.7);
      dist = clamp(dist * clamp(s, 0.45, 2.6), near, 40000);
    }
    CAM.dist = cut ? dist : damp(CAM.dist, dist, 3, dt);
    SHOT.pos.copy(SHOT.aim).addScaledVector(SHOT.dir, CAM.dist);
  } else {
    SHOT.pos.copy(SHOT.aim).addScaledVector(SHOT.dir, dist);
    if (SHOT.solve) {
      // Locked off: hold the ground, open the lens instead.
      lookBasis(SHOT.pos, SHOT.aim);
      fovWant = 2 * Math.atan(fitTan(SHOT.pos) / fill) / DEG;
    }
  }
  fovWant = clamp(fovWant, SHOT.lo, SHOT.hi);

  // No shot is worth flying underground to get.
  if (SHOT.pos.y < 2.5) SHOT.pos.y = 2.5;

  /* Damp toward the framing, except across a cut, which must be instant
     or the camera visibly flies between setups.

     Before damping, the vehicle's own travel this frame is added to the
     camera state: the aim always carries it, and the eye carries it too
     for the shots that ride along. Only the framing offset is then left
     to damp, so the shot has no steady-state lag however fast the stack
     is going - a plain damped follow trails a target by v/lambda, which
     at two kilometres a second is precisely what walks the vehicle off
     the edge of the frame. Feeding the vehicle forward rather than the
     framing also means the offset jumps at separation and at fairing
     deploy still ease in, instead of popping the picture sideways. */
  if (cut) {
    CAM.pos.copy(SHOT.pos); CAM.target.copy(SHOT.aim); CAM.fov = fovWant;
    CAM.guard = 0;
  } else {
    _e.subVectors(vehicle.position, CAM.anchor);
    CAM.target.add(_e);
    if (SHOT.rides) CAM.pos.add(_e);
    const lam = SHOT.lam;
    CAM.pos.x = damp(CAM.pos.x, SHOT.pos.x, lam, dt);
    CAM.pos.y = damp(CAM.pos.y, SHOT.pos.y, lam, dt);
    CAM.pos.z = damp(CAM.pos.z, SHOT.pos.z, lam, dt);
    CAM.target.x = damp(CAM.target.x, SHOT.aim.x, lam, dt);
    CAM.target.y = damp(CAM.target.y, SHOT.aim.y, lam, dt);
    CAM.target.z = damp(CAM.target.z, SHOT.aim.z, lam, dt);
    CAM.fov = damp(CAM.fov, fovWant, 4, dt);
  }
  CAM.anchor.copy(vehicle.position);

  camera.position.copy(CAM.pos);
  camera.lookAt(CAM.target);

  /* --- shake ---------------------------------------------------------
     Two independent sources:
       acoustic  the pressure wave off the plume, 1/r with distance and
                 delayed by the time of flight of sound
       buffet    airframe vibration through max Q, felt only by the
                 camera bolted to the vehicle                           */
  const enginePt = _tmp.copy(vehicle.position);
  const d = camera.position.distanceTo(enginePt);
  const heard = acousticAt(d / 343);
  const acou = heard * (70 / (70 + d)) * (1 - smoothstep(2000, 12000, FL.alt));

  // Only the camera bolted to the airframe feels the buffet; the chase
  // plate is two hundred metres off the flank and feels nothing.
  const onboard = mode === 4 ? 1 : 0;
  const buffet = onboard * (FL.qmax > 0 ? FL.q / 34000 : 0) * 0.9;

  const amp = (acou * 1.25 + buffet);
  if (amp > 0.002) {
    const t = now;
    _sv.set(fbm(t * 17.3), fbm(t * 19.7 + 31), fbm(t * 13.1 + 77) * 0.6)
       .multiplyScalar(amp * SHOT.shakePos * 0.55)
       .applyQuaternion(camera.quaternion);
    camera.position.add(_sv);

    // Angular shake is in camera-local axes, so a long lens magnifies it
    // exactly the way a real telephoto tracking shot does.
    const k = amp * SHOT.shakeRot * 0.0022;
    camera.rotateX(fbm(t * 23.9 + 9) * k);
    camera.rotateY(fbm(t * 21.1 + 3) * k);
    camera.rotateZ(fbm(t * 11.7 + 5) * k * 0.7);
  }

  /* --- framing guard --------------------------------------------------
     Last line of defence. Whatever the damping, the viewer's drag and
     the shake have between them done to the frame, measure it once more
     from where the camera actually ended up and open the lens if any
     part of the vehicle has been pushed outside. It opens at once and
     recovers slowly, so a transient cannot make the lens pump. */
  let fov = CAM.fov;
  if (SHOT.solve) {
    _r.set(1, 0, 0).applyQuaternion(camera.quaternion);
    _u.set(0, 1, 0).applyQuaternion(camera.quaternion);
    _f.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const need = 2 * Math.atan(fitTan(camera.position) / FRAME_GUARD) / DEG;
    CAM.guard = Math.max(need - CAM.fov, damp(CAM.guard, 0, 1.6, dt));
    fov = clamp(CAM.fov + Math.max(0, CAM.guard), SHOT.lo, SHOT.hi);
  }
  if (Math.abs(camera.fov - fov) > 0.001) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }

  // The sky sphere rides with the camera so it can never be flown out of.
  sky.position.copy(camera.position);

  // Point sprites are sized in pixels, so the scale factor folds in both
  // the current field of view and the drawing buffer height.
  exhaustMat.uniforms.uScale.value =
    renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360));
}

/* --- adaptive quality -------------------------------------------------
   Frame cost is watched over a moving window. If the machine cannot hold
   the budget the particle spawn rate is cut first, then the engine
   light's shadow pass, then the pixel ratio - cheapest visual loss
   first. Recovery needs a longer good streak than the drop needed bad
   frames, so it cannot oscillate. */
let qAcc = 0, qFrames = 0, qGood = 0;

function updateQuality(frameMs) {
  qAcc += frameMs; qFrames++;
  if (qFrames < 60) return;
  const mean = qAcc / qFrames;
  qAcc = 0; qFrames = 0;

  if (mean > 26 && quality.level > 0) {
    quality.level--;
    qGood = 0;
    applyQuality();
  } else if (mean < 18) {
    if (++qGood >= 6 && quality.level < 2) { quality.level++; qGood = 0; applyQuality(); }
  } else {
    qGood = 0;
  }
}

function applyQuality() {
  if (quality.level === 2) {
    quality.spawn = 1; quality.engineShadow = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  } else if (quality.level === 1) {
    quality.spawn = 0.6; quality.engineShadow = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
  } else {
    quality.spawn = 0.35; quality.engineShadow = false;
    renderer.setPixelRatio(1);
  }
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}
