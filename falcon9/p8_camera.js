/* -- 10 -- camera director --------------------------------------------
   Five framings plus an auto-director that cuts between them. Each one
   only has to publish a desired position, look-at point and field of
   view; the director damps toward them, snaps on a cut, and then lays
   procedural shake on top.                                             */

const quality = { spawn: 1, engineShadow: true, level: 2 };

const CAM = {
  mode: 0,            // 0 = auto
  active: 1,
  last: -1,
  fov: 32,
  pos: new Vector3(72, 26, 88),
  target: new Vector3(0, 35, 0),
  orbitYaw: 0, orbitPitch: 0, orbitZoom: 1
};

const wantPos = new Vector3(), wantTarget = new Vector3();
const _sv = new Vector3(), _off = new Vector3(), _tmp = new Vector3();

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

/* Where the camera should be pointing: the middle of whatever is still
   flying. */
function vehicleCentre(out) {
  const up = _tmp.set(0, 1, 0).applyQuaternion(vehicle.quaternion);
  const h = FL.sepT !== null ? V.S2_TOP - 6 : 34;
  return out.copy(vehicle.position).addScaledVector(up, h);
}

function autoPick() {
  const t = FL.t;
  if (t < 9) return 1;                                     // on the pad
  if (t < 44) return 2;                                    // long lens
  if (FL.mecoT !== null && t > FL.mecoT - 2 && t < FL.mecoT + 18) return 4;
  if (FL.fired.fairing && t < FL.fired.fairing + 12) return 4;
  return 3;                                                // chase
}

function updateCamera(dt, now) {
  const mode = CAM.mode === 0 ? autoPick() : CAM.mode;
  const cut = mode !== CAM.last;
  CAM.last = mode;
  CAM.active = mode;

  vehicleCentre(wantTarget);
  const centre = _off.copy(wantTarget);
  let fov = 32, shakePos = 0, shakeRot = 1;

  if (mode === 1) {
    /* --- PAD: a ground camera inside the perimeter, dollying slowly. */
    const k = clamp(FL.t * 0.02, 0, 1);
    wantPos.set(58 - k * 9, 7.5 + k * 6, 66 - k * 5);
    wantTarget.set(FL.down * 0.35, PAD_DECK + Math.min(FL.alt, 260) + 26, 0);
    fov = lerp(40, 52, smoothstep(0, 320, FL.alt));
    shakePos = 1.0; shakeRot = 1.0;

  } else if (mode === 2) {
    /* --- TRACKER: a long lens 700 m out. The field of view is solved so
       the 70 m stack keeps a constant share of the frame, which is what a
       real tracking operator is doing by hand. */
    wantPos.set(-180, 12, 690);
    const d = wantPos.distanceTo(centre);
    const want = 2 * Math.atan((70 / 0.42) * 0.5 / d) * 180 / Math.PI;
    fov = clamp(want, 2.4, 42);
    shakePos = 0.12; shakeRot = 1.5;

  } else if (mode === 3) {
    /* --- CHASE: an offset fixed in the vehicle's own frame, slowly
       orbiting the body axis so the stack turns in view. */
    const ax = _tmp.set(0, 1, 0).applyQuaternion(vehicle.quaternion);
    const a = now * 0.07;
    const side = new Vector3(Math.cos(a), 0, Math.sin(a))
      .applyQuaternion(vehicle.quaternion).multiplyScalar(52);
    wantPos.copy(centre).add(side).addScaledVector(ax, -16);
    fov = 38;
    shakePos = 0.35; shakeRot = 0.6;

  } else if (mode === 4) {
    /* --- ONBOARD: bracketed to the interstage, looking back down the
       vehicle at the engines and the receding ground. */
    const ax = _tmp.set(0, 1, 0).applyQuaternion(vehicle.quaternion);
    const rt = new Vector3(1, 0, 0).applyQuaternion(vehicle.quaternion);
    const mountH = FL.sepT !== null ? V.S2_TOP - 2 : V.INTER_TOP - 1.5;
    wantPos.copy(vehicle.position)
      .addScaledVector(ax, mountH)
      .addScaledVector(rt, V.R + 1.1);
    wantTarget.copy(vehicle.position).addScaledVector(ax, -55).addScaledVector(rt, 12);
    fov = 68;
    shakePos = 0.5; shakeRot = 0.9;

  } else {
    /* --- FREE: a plain orbit the viewer drives. */
    wantPos.copy(centre).add(new Vector3(70, 22, 90).multiplyScalar(CAM.orbitZoom));
    fov = 36;
    shakePos = 0.25; shakeRot = 0.4;
  }

  /* Viewer look-around: yaw about world up and pitch about the camera's
     right vector, applied to the offset from the look-at point. */
  if (CAM.orbitYaw || CAM.orbitPitch || CAM.orbitZoom !== 1) {
    _sv.subVectors(wantPos, wantTarget);
    const r = _sv.length();
    let yaw = Math.atan2(_sv.x, _sv.z) + CAM.orbitYaw;
    let pitch = clamp(Math.asin(clamp(_sv.y / r, -1, 1)) + CAM.orbitPitch, -1.35, 1.45);
    const cr = Math.cos(pitch) * r * (mode === 5 ? 1 : CAM.orbitZoom);
    wantPos.set(
      wantTarget.x + Math.sin(yaw) * cr,
      wantTarget.y + Math.sin(pitch) * r * (mode === 5 ? 1 : CAM.orbitZoom),
      wantTarget.z + Math.cos(yaw) * cr
    );
  }

  /* Damp toward the framing, except across a cut, which must be instant
     or the camera visibly flies between setups. */
  if (cut) {
    CAM.pos.copy(wantPos); CAM.target.copy(wantTarget); CAM.fov = fov;
  } else {
    const lam = mode === 2 ? 9 : 5;
    CAM.pos.x = damp(CAM.pos.x, wantPos.x, lam, dt);
    CAM.pos.y = damp(CAM.pos.y, wantPos.y, lam, dt);
    CAM.pos.z = damp(CAM.pos.z, wantPos.z, lam, dt);
    CAM.target.x = damp(CAM.target.x, wantTarget.x, lam, dt);
    CAM.target.y = damp(CAM.target.y, wantTarget.y, lam, dt);
    CAM.target.z = damp(CAM.target.z, wantTarget.z, lam, dt);
    CAM.fov = damp(CAM.fov, fov, 4, dt);
  }

  camera.position.copy(CAM.pos);
  camera.lookAt(CAM.target);
  if (Math.abs(camera.fov - CAM.fov) > 0.001) {
    camera.fov = CAM.fov;
    camera.updateProjectionMatrix();
  }

  /* --- shake ---------------------------------------------------------
     Two independent sources:
       acoustic  the pressure wave off the plume, 1/r with distance and
                 delayed by the time of flight of sound
       buffet    airframe vibration through max Q, felt only by cameras
                 bolted to the vehicle                                  */
  const enginePt = _tmp.copy(vehicle.position);
  const d = camera.position.distanceTo(enginePt);
  const heard = acousticAt(d / 343);
  const acou = heard * (70 / (70 + d)) * (1 - smoothstep(2000, 12000, FL.alt));

  const onboard = (mode === 3 || mode === 4) ? 1 : 0;
  const buffet = onboard * (FL.qmax > 0 ? FL.q / 34000 : 0) * 0.9;

  const amp = (acou * 1.25 + buffet);
  if (amp > 0.002) {
    const t = now;
    _sv.set(fbm(t * 17.3), fbm(t * 19.7 + 31), fbm(t * 13.1 + 77) * 0.6)
       .multiplyScalar(amp * shakePos * 0.55)
       .applyQuaternion(camera.quaternion);
    camera.position.add(_sv);

    // Angular shake is in camera-local axes, so a long lens magnifies it
    // exactly the way a real telephoto tracking shot does.
    const k = amp * shakeRot * 0.0022;
    camera.rotateX(fbm(t * 23.9 + 9) * k);
    camera.rotateY(fbm(t * 21.1 + 3) * k);
    camera.rotateZ(fbm(t * 11.7 + 5) * k * 0.7);
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
