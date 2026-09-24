/* -- 7 -- the vehicle -------------------------------------------------
   Every part is authored at its true station height above the engine
   gimbal plane, so the stack assembles itself from the numbers in V.

     vehicle   carries world position and attitude
       stage1  booster, legs, grid fins, interstage      (jettisoned)
       upper   second stage + Merlin Vacuum + fairing
         fairing
           halfA / halfB                                  (jettisoned)
*/
const vehicle = new THREE.Group();
scene.add(vehicle);

const stage1 = new THREE.Group();
const upper  = new THREE.Group();
vehicle.add(stage1, upper);

/* Hull finish: faint vertical panel seams, ring welds where the barrel
   sections are stir-welded together, and soot creeping up from the base.
   Wrapped once around the cylinder, so u runs round and v runs up. */
function makeHullTexture() {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  g.fillStyle = '#e9eaec';
  g.fillRect(0, 0, W, H);

  // Vertical panel seams.
  g.lineWidth = 1;
  for (let x = 0; x < W; x += 64) {
    g.strokeStyle = 'rgba(155,160,168,0.40)';
    g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke();
  }
  // Ring welds: the horizontal joints between barrel sections.
  for (let y = 26; y < H; y += 52) {
    g.strokeStyle = 'rgba(150,156,164,0.34)';
    g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.beginPath(); g.moveTo(0, y + 2.5); g.lineTo(W, y + 2.5); g.stroke();
  }
  // Soot rising off the engine bay (v = 0 is the bottom of the cylinder).
  const grime = g.createLinearGradient(0, H, 0, H * 0.72);
  grime.addColorStop(0, 'rgba(56,54,54,0.55)');
  grime.addColorStop(1, 'rgba(56,54,54,0)');
  g.fillStyle = grime;
  g.fillRect(0, H * 0.72, W, H * 0.28);

  // Vehicle markings. Original marks only - a stencilled serial block and
  // two caution stripes, no third-party insignia.
  g.fillStyle = '#1a1c1f';
  g.fillRect(96, 150, 118, 13);
  g.fillRect(96, 172, 62, 7);
  g.font = '600 26px "Barlow Condensed", Arial, sans-serif';
  g.fillText('B1084 - 09', 96, 140);
  g.fillStyle = 'rgba(40,44,50,0.65)';
  for (let i = 0; i < 9; i++) g.fillRect(96 + i * 16, 196, 9, 5);

  const t = new THREE.CanvasTexture(c);
  if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}

const hullMat = MAT.hull.clone();
hullMat.map = makeHullTexture();

/* --- booster: thrust structure and nine Merlins --------------------- */
(function buildEngines() {
  // Octaweb skirt, slightly flared and heavily sooted.
  const skirt = mesh(new THREE.CylinderGeometry(V.R, V.R * 1.02, V.ENGINE_BAY, 44, 1, true),
                     MAT.soot, 0, V.ENGINE_BAY / 2, 0);
  skirt.material = MAT.soot.clone();
  skirt.material.side = THREE.DoubleSide;
  stage1.add(skirt);

  // The eight radial webs the engine bays are bolted into.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    const web = mesh(new THREE.BoxGeometry(1.5, 2.2, 0.14), MAT.dark,
                     Math.cos(a) * 1.05, 1.2, Math.sin(a) * 1.05);
    web.rotation.y = -a;
    stage1.add(web);
  }

  // Nine Merlin 1D bells: one on the centreline, eight on a 1.18 m ring.
  // The nozzle is a truncated cone, open at both ends so the inside of the
  // bell is visible from below.
  const bell = new THREE.CylinderGeometry(0.29, 0.47, 1.62, 16, 1, true);
  const throat = new THREE.CylinderGeometry(0.22, 0.29, 0.5, 12);
  const pump = new THREE.BoxGeometry(0.42, 0.5, 0.42);
  const engines = [];
  for (let i = 0; i < 9; i++) {
    const r = i === 0 ? 0 : 1.18;
    const a = i === 0 ? 0 : ((i - 1) / 8) * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const b = mesh(bell, MAT.nozzle, x, 0.90, z);
    stage1.add(b);
    stage1.add(mesh(throat, MAT.metal, x, 1.85, z));
    if (i > 0) stage1.add(mesh(pump, MAT.metal, x * 1.28, 2.35, z * 1.28));
    engines.push(new Vector3(x, 0.1, z));
  }
  vehicle.userData.engines = engines;
})();

/* --- booster tank, raceway, interstage ------------------------------ */
(function buildBooster() {
  const tankH = V.S1_TOP - V.ENGINE_BAY;
  stage1.add(mesh(new THREE.CylinderGeometry(V.R, V.R, tankH, 48, 1, false),
                  hullMat, 0, V.ENGINE_BAY + tankH / 2, 0));

  // Raceway: the conduit carrying wiring and pressurant up the side.
  const race = mesh(new THREE.CylinderGeometry(0.30, 0.30, tankH - 1.5, 10),
                    MAT.paint, 0, V.ENGINE_BAY + tankH / 2, -(V.R + 0.04));
  race.scale.set(1.5, 1, 0.55);
  stage1.add(race);

  // Black composite interstage, and the pusher ring at its top.
  const interH = V.INTER_TOP - V.S1_TOP;
  stage1.add(mesh(new THREE.CylinderGeometry(V.R, V.R, interH, 48, 1, true),
                  MAT.black, 0, V.S1_TOP + interH / 2, 0));
  stage1.add(mesh(new THREE.CylinderGeometry(V.R * 1.008, V.R * 1.008, 0.35, 48),
                  MAT.dark, 0, V.INTER_TOP - 0.2, 0));
  // Cold-gas thruster pods at the top of the booster.
  for (const a of [0.6, Math.PI - 0.6]) {
    stage1.add(mesh(new THREE.BoxGeometry(0.7, 0.9, 0.7), MAT.metal,
                    Math.cos(a) * V.R, V.S1_TOP - 1.6, Math.sin(a) * V.R));
  }
})();

/* --- grid fins, stowed ----------------------------------------------
   Folded flat against the booster below the interstage. The lattice is
   assembled from the same strut helper as the pad towers, so each fin is
   a single InstancedMesh of 18 members. */
(function buildGridFins() {
  const FIN_Y = 37.6, HW = 0.76, HH = 0.60, X0 = 0.30, TH = 0.055;
  for (let k = 0; k < 4; k++) {
    const g = new THREE.Group();
    const a = (k / 4) * TAU + Math.PI / 4;
    g.position.set(Math.cos(a) * V.R, FIN_Y, Math.sin(a) * V.R);
    g.rotation.y = -a;

    const t = new Truss();
    // Outer frame.
    t.add(X0, -HH, -HW, X0,  HH, -HW, 0.075);
    t.add(X0, -HH,  HW, X0,  HH,  HW, 0.075);
    t.add(X0,  HH, -HW, X0,  HH,  HW, 0.075);
    t.add(X0, -HH, -HW, X0, -HH,  HW, 0.075);
    // Lattice: the cells are what make a grid fin work in hypersonic flow.
    for (let i = 1; i < 7; i++) {
      const z = -HW + (i / 7) * HW * 2;
      t.add(X0, -HH, z, X0, HH, z, TH);
    }
    for (let i = 1; i < 6; i++) {
      const y = -HH + (i / 6) * HH * 2;
      t.add(X0, y, -HW, X0, y, HW, TH);
    }
    g.add(t.build(MAT.dark));
    // Hinge and actuator housing between the fin and the skin.
    g.add(mesh(new THREE.BoxGeometry(0.34, 1.5, 0.9), MAT.soot, 0.14, 0, 0));
    stage1.add(g);
  }
})();

/* --- landing legs, folded ------------------------------------------- */
(function buildLegs() {
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU;
    const g = new THREE.Group();
    g.rotation.y = -a;
    // A slender black fairing lying against the tank, pointed at the top.
    const body = mesh(new THREE.CylinderGeometry(0.19, 0.50, 10.6, 12), MAT.black,
                      V.R + 0.30, 7.0, 0);
    body.scale.set(0.85, 1, 1.75);
    body.rotation.z = -0.012;                // the slight outward lean
    g.add(body);
    const tip = mesh(new THREE.ConeGeometry(0.19, 1.6, 12), MAT.black, V.R + 0.36, 13.1, 0);
    tip.scale.set(0.85, 1, 1.75);
    g.add(tip);
    // Foot and the pinned attachment at the thrust structure.
    const foot = mesh(new THREE.BoxGeometry(0.8, 1.4, 1.5), MAT.black, V.R + 0.24, 1.5, 0);
    g.add(foot);
    g.add(mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.9, 8), MAT.metal, V.R + 0.05, 2.7, 0));
    stage1.add(g);
  }
})();

/* --- second stage and the Merlin Vacuum ----------------------------- */
(function buildUpper() {
  const h = V.S2_TOP - V.INTER_TOP;
  upper.add(mesh(new THREE.CylinderGeometry(V.R, V.R, h, 48), hullMat,
                 0, V.INTER_TOP + h / 2, 0));

  // MVac hangs down inside the interstage and is only revealed at
  // separation: a short chamber and a large niobium radiative extension.
  upper.add(mesh(new THREE.CylinderGeometry(0.34, 0.5, 1.1, 14), MAT.metal, 0, V.INTER_TOP - 0.6, 0));
  const skirtGeo = new THREE.CylinderGeometry(0.5, 1.42, 3.2, 20, 1, true);
  const mv = mesh(skirtGeo, MAT.copper, 0, V.INTER_TOP - 2.7, 0);
  mv.material = MAT.copper.clone();
  mv.material.side = THREE.DoubleSide;
  upper.add(mv);
  vehicle.userData.mvacY = V.INTER_TOP - 4.3;
})();

/* --- payload fairing -------------------------------------------------
   A blunted tangent ogive turned on a lathe. For a nose of length L on a
   base radius R the generating arc has radius rho = (R^2 + L^2) / 2R, and
   at distance x back from the tip the profile radius is
        r(x) = sqrt(rho^2 - (L - x)^2) + R - rho
   which is exactly tangent to the barrel where the two meet.           */
const fairing = new THREE.Group();
fairing.position.y = V.S2_TOP;
upper.add(fairing);
const fairingHalves = [];

(function buildFairing() {
  const R = V.FAIR_R;
  const shoulder = V.FAIR_SHOULD - V.S2_TOP;      // 2.6 m taper
  const barrelTop = V.FAIR_CYL - V.S2_TOP;        // 8.1 m
  const L = V.TOP - V.FAIR_CYL;                   // 4.9 m nose
  const rho = (R * R + L * L) / (2 * R);

  const pts = [];
  pts.push(new Vector2(V.R, 0));
  pts.push(new Vector2(V.R + (R - V.R) * 0.55, shoulder * 0.42));
  pts.push(new Vector2(R, shoulder));
  pts.push(new Vector2(R, barrelTop));
  // Walk the ogive down from the barrel to a blunt cap.
  const TIP_CUT = 0.34;
  for (let i = 1; i <= 16; i++) {
    const x = L - (i / 16) * (L - TIP_CUT);       // distance back from the tip
    const r = Math.sqrt(Math.max(0, rho * rho - (L - x) * (L - x))) + R - rho;
    pts.push(new Vector2(Math.max(r, 0.01), barrelTop + (L - x)));
  }
  pts.push(new Vector2(0.30, barrelTop + L - 0.09));
  pts.push(new Vector2(0.0,  barrelTop + L));

  const fairMat = new THREE.MeshStandardMaterial({
    color: 0xf1f2f3, roughness: 0.40, metalness: 0.06, side: THREE.DoubleSide
  });

  // Two half-shells. The seam runs along +/- X so the halves swing clear
  // across the flight plane, which is how they are actually jettisoned.
  for (let i = 0; i < 2; i++) {
    const half = new THREE.Mesh(
      new THREE.LatheGeometry(pts, 40, Math.PI / 2 + i * Math.PI, Math.PI), fairMat
    );
    half.castShadow = true; half.receiveShadow = true;
    const hinge = new THREE.Group();
    hinge.add(half);
    fairing.add(hinge);
    fairingHalves.push(hinge);
  }
  // The separation seam itself, a shallow raised rib run along the
  // straight barrel only - above the barrel the profile is curving in and
  // a straight rib would float clear of the shell.
  for (const s of [-1, 1]) {
    fairing.add(mesh(new THREE.BoxGeometry(0.1, barrelTop - shoulder, 0.06),
                     MAT.paint, s * (R - 0.01), (shoulder + barrelTop) / 2, 0));
  }
})();

/* Every mesh under the vehicle casts and receives. */
vehicle.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
