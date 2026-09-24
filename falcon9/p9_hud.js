/* -- 11 -- HUD, input and the main loop ------------------------------- */

const SEQ_SHOW = {
  ignition: 'T-00:02', liftoff: 'T+00:00', pitch: 'T+00:12', maxq: 'T+01:12',
  meco: 'T+02:37', sep: 'T+02:41', ses1: 'T+02:44', fairing: 'T+03:15',
  seco: 'T+09:02'
};

const seqEl = $('seq');
const seqRows = Object.create(null);
for (const s of SEQUENCE) {
  const li = document.createElement('li');
  li.innerHTML = '<span class="at">' + SEQ_SHOW[s.key] + '</span><span class="nm"></span>';
  li.lastChild.textContent = s.label;
  seqEl.appendChild(li);
  seqRows[s.key] = li;
}

let calloutTimer = 0;
function showCallout(text, hot) {
  const el = $('callout');
  el.textContent = text;
  el.classList.toggle('hot', !!hot);
  el.classList.add('show');
  clearTimeout(calloutTimer);
  calloutTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function markSequence(key) {
  const li = seqRows[key];
  if (!li) return;
  li.className = 'now';
  li.firstChild.textContent = fmtMET(FL.t, true);
  for (const k in seqRows) if (k !== key && seqRows[k].className === 'now') seqRows[k].className = 'done';
}

/* --- formatting ------------------------------------------------------ */
function fmtMET(t, short) {
  const sign = t < 0 ? '-' : '+';
  const a = Math.abs(t);
  const h = Math.floor(a / 3600), m = Math.floor(a / 60) % 60, s = Math.floor(a % 60);
  const p = (n) => String(n).padStart(2, '0');
  return short ? 'T' + sign + p(m) + ':' + p(s)
               : 'T' + sign + p(h) + ':' + p(m) + ':' + p(s);
}
/* Thin-space grouping keeps long figures readable without a comma that
   would fight the tabular alignment. */
function group(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
function unit(v, u) { return v + '<u>' + u + '</u>'; }

const meterEl = $('meter');
for (let i = 0; i < 10; i++) meterEl.appendChild(document.createElement('i'));
const meterSegs = meterEl.children;

let hudAcc = 0;
function updateHUD(dt) {
  hudAcc += dt;
  if (hudAcc < 0.08) return;     // 12 Hz is plenty and avoids layout churn
  hudAcc = 0;

  $('met').textContent = fmtMET(FL.t, false);

  let phase = 'Terminal count';
  if (FL.fired.seco) phase = 'Orbit insertion complete';
  else if (FL.stage === 2) phase = 'Stage 2 ascent';
  else if (FL.sepT !== null) phase = 'Coast to ignition';
  else if (FL.mecoT !== null) phase = 'Post MECO coast';
  else if (FL.t >= 0) phase = 'Stage 1 ascent';
  else if (FL.t >= IGNITION_T) phase = 'Ignition - clamps engaged';
  $('phase').textContent = phase;

  $('alt').innerHTML = FL.alt < 1000
    ? unit(group(FL.alt), 'm')
    : unit((FL.alt / 1000).toFixed(FL.alt < 100000 ? 1 : 0), 'km');
  $('spd').innerHTML = unit(group(FL.vmag * 3.6), 'km/h');
  $('dr').innerHTML  = unit((FL.down / 1000).toFixed(1), 'km');
  $('mach').textContent = FL.mach.toFixed(2);
  $('qbar').innerHTML = unit((FL.q / 1000).toFixed(1), 'kPa');
  $('thr').innerHTML = unit(Math.round(FL.throttle * 100), '%');
  $('gee').innerHTML = unit(FL.gLoad.toFixed(2), 'g');

  const lit = Math.round(FL.throttle * 10);
  for (let i = 0; i < 10; i++) meterSegs[i].className = i < lit ? 'lit' : '';
}

/* --- reset ------------------------------------------------------------
   Anything that gets re-parented during flight has its original parent
   and local transform recorded up front, so a reset is exact rather than
   a rebuild. */
const RESET_T = [];
function remember(obj) {
  RESET_T.push({
    obj, parent: obj.parent,
    p: obj.position.clone(), e: obj.rotation.clone(), s: obj.scale.clone()
  });
}
remember(stage1);
remember(fairingHalves[0]);
remember(fairingHalves[1]);

function resetFlight() {
  Object.assign(FL, {
    running: false, t: -10, alt: 0, down: 0, vx: 0, vy: 0,
    pitch: 0, roll: 0, mass: P.m0, prop1: P.m1_prop, prop2: P.m2_prop,
    throttle: 0, thrust: 0, q: 0, qmax: 0, mach: 0, gLoad: 0, vmag: 0,
    stage: 1, fairingOn: true, fired: Object.create(null),
    mecoT: null, sepT: null
  });

  debris.length = 0;
  for (const r of RESET_T) {
    r.parent.add(r.obj);                 // add() re-parents in LOCAL space
    r.obj.position.copy(r.p);
    r.obj.rotation.set(r.e.x, r.e.y, r.e.z);
    r.obj.scale.copy(r.s);
  }

  exhaust.clear();
  acoustic.fill(0);
  renderer.shadowMap.autoUpdate = true;
  renderer.shadowMap.needsUpdate = true;
  jetUniforms.uThrottle.value = 0;
  flashSprite.scale.setScalar(0.01);
  renderer.toneMappingExposure = 1;

  CAM.last = -1;                         // force a hard cut on the next frame
  CAM.orbitYaw = CAM.orbitPitch = 0; CAM.orbitZoom = 1;

  for (const k in seqRows) {
    seqRows[k].className = '';
    seqRows[k].firstChild.textContent = SEQ_SHOW[k];
  }
  $('callout').classList.remove('show');
  updatePad(0);
  placeVehicle(0);
}

/* --- input ------------------------------------------------------------ */
let timeScale = 1;
let started = false;

function begin() {
  if (!started) {
    started = true;
    $('start').classList.add('gone');
    $('hud').classList.add('live');
    setTimeout(() => { $('start').hidden = true; }, 800);
  }
  FL.running = true;
}

function setCam(mode) {
  CAM.mode = mode;
  CAM.orbitYaw = CAM.orbitPitch = 0;
  for (const b of document.querySelectorAll('[data-cam]')) {
    b.classList.toggle('on', Number(b.dataset.cam) === mode);
  }
}
function setRate(r) {
  timeScale = r;
  for (const b of document.querySelectorAll('[data-rate]')) {
    b.classList.toggle('on', Number(b.dataset.rate) === r);
  }
}

$('go').addEventListener('click', begin);
$('reset').addEventListener('click', () => { resetFlight(); begin(); });
for (const b of document.querySelectorAll('[data-cam]')) {
  b.addEventListener('click', () => setCam(Number(b.dataset.cam)));
}
for (const b of document.querySelectorAll('[data-rate]')) {
  b.addEventListener('click', () => setRate(Number(b.dataset.rate)));
}

const RATES = [0.25, 0.5, 1, 2, 4, 8, 16];
window.addEventListener('keydown', (e) => {
  if (e.key === ' ') { e.preventDefault(); begin(); }
  else if (e.key >= '0' && e.key <= '5') setCam(Number(e.key));
  else if (e.key === 'r' || e.key === 'R') { resetFlight(); begin(); }
  else if (e.key === '-' || e.key === '_') {
    setRate(RATES[Math.max(0, RATES.indexOf(timeScale) - 1)] || 0.25);
  } else if (e.key === '=' || e.key === '+') {
    setRate(RATES[Math.min(RATES.length - 1, RATES.indexOf(timeScale) + 1)]);
  }
});

/* Drag to look around, wheel to pull back. */
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  CAM.orbitYaw   -= (e.clientX - lastX) * 0.005;
  CAM.orbitPitch += (e.clientY - lastY) * 0.004;
  CAM.orbitPitch = clamp(CAM.orbitPitch, -1.2, 1.2);
  lastX = e.clientX; lastY = e.clientY;
});
const endDrag = () => { dragging = false; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  CAM.orbitZoom = clamp(CAM.orbitZoom * (1 + Math.sign(e.deltaY) * 0.12), 0.25, 5);
}, { passive: false });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

/* --- main loop --------------------------------------------------------
   Physics runs on a fixed 1/120 s step inside an accumulator, so the
   trajectory is identical at 30 fps, 60 fps or 144 fps and does not
   change when the time rate is turned up. Rendering, particles and the
   camera all run on the real frame delta.                              */
const FIXED = 1 / 120;
let acc = 0, prev = performance.now(), simClock = 0;

function frame(now) {
  requestAnimationFrame(frame);

  const raw = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  const dt = raw * timeScale;
  simClock += dt;

  if (FL.running) {
    acc += dt;
    let guard = 0;
    while (acc >= FIXED && guard++ < 600) { step(FIXED); acc -= FIXED; }
    if (acc > FIXED) acc = 0;          // the tab was backgrounded; do not catch up
  }

  updatePad(dt);
  placeVehicle(simClock);

  // Particles are given a capped step: at 16x nothing useful is gained by
  // integrating a quarter-second of smoke in one go, and the plume stays
  // stable instead of tearing itself apart.
  const pdt = Math.min(0.06, dt);
  emitExhaust(pdt, simClock);
  exhaust.update(pdt, {
    impactY: FL.alt < 45 ? 2.6 : 0.4,
    padFlow: FL.alt < 45 ? 1 : 0
  });

  updateEngineLight(simClock);
  pushAcoustic(dt, FL.throttle);
  updateCamera(raw, simClock);
  updateSky(FL.alt);
  updateHUD(raw);

  renderer.render(scene, camera);
  updateQuality(raw * 1000);
}

/* --- go --------------------------------------------------------------- */
setCam(0);
setRate(1);
resetFlight();
updateSky(0);
updateCamera(0.016, 0);
requestAnimationFrame(frame);
