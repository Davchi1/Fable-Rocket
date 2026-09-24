/* -- 6 -- pad structures ---------------------------------------------
   The truss work is built through one helper that turns a list of
   (start, end, radius) line segments into a single InstancedMesh: the
   whole strongback and all three lightning masts cost one draw call
   each instead of several hundred.                                    */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UP = new Vector3(0, 1, 0);

class Truss {
  constructor() { this.items = []; }
  /* ax..bz in metres, r = half-thickness of the square member. */
  add(ax, ay, az, bx, by, bz, r) {
    this.items.push([ax, ay, az, bx, by, bz, r]);
    return this;
  }
  build(material) {
    const n = this.items.length;
    const mesh = new THREE.InstancedMesh(UNIT_BOX, material, n);
    const m = new Matrix4(), q = new Quaternion();
    const a = new Vector3(), b = new Vector3(), mid = new Vector3(), dir = new Vector3(), s = new Vector3();
    for (let i = 0; i < n; i++) {
      const it = this.items[i];
      a.set(it[0], it[1], it[2]); b.set(it[3], it[4], it[5]);
      dir.subVectors(b, a);
      const len = dir.length();
      if (len < 1e-5) { m.makeScale(0, 0, 0); mesh.setMatrixAt(i, m); continue; }
      mid.addVectors(a, b).multiplyScalar(0.5);
      // Orient the unit box's +Y axis along the member, then stretch it.
      q.setFromUnitVectors(UP, dir.divideScalar(len));
      s.set(it[6] * 2, len, it[6] * 2);
      m.compose(mid, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }
}

const MAT = {
  hull:   new THREE.MeshStandardMaterial({ color: 0xe9eaec, roughness: 0.45, metalness: 0.14 }),
  black:  new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.74, metalness: 0.06 }),
  soot:   new THREE.MeshStandardMaterial({ color: 0x2b2c30, roughness: 0.88, metalness: 0.10 }),
  metal:  new THREE.MeshStandardMaterial({ color: 0x8e949c, roughness: 0.36, metalness: 0.86 }),
  nozzle: new THREE.MeshStandardMaterial({ color: 0x585d64, roughness: 0.32, metalness: 0.92, side: THREE.DoubleSide }),
  steel:  new THREE.MeshStandardMaterial({ color: 0x737a85, roughness: 0.56, metalness: 0.72 }),
  paint:  new THREE.MeshStandardMaterial({ color: 0xb9bdc2, roughness: 0.62, metalness: 0.24 }),
  dark:   new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.9,  metalness: 0.15 }),
  copper: new THREE.MeshStandardMaterial({ color: 0x6d5236, roughness: 0.5,  metalness: 0.8 })
};

const PAD_DECK = 6.9;   // height of the launch mount deck (m)
const clamps = [];      // hold-down arms, released at T-0
const pad = new THREE.Group();
scene.add(pad);

function mesh(geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x || 0, y || 0, z || 0);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

/* --- launch mount: an octagonal steel table with the exhaust aperture
   cut straight through it, built from an extruded Shape with a hole. */
(function buildMount() {
  const octagon = (radius, path) => {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + Math.PI / 8;
      const x = Math.cos(a) * radius, y = Math.sin(a) * radius;
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
    path.closePath();
    return path;
  };

  const shape = octagon(9.4, new THREE.Shape());
  shape.holes.push(octagon(3.6, new THREE.Path()));
  const deckGeo = new THREE.ExtrudeGeometry(shape, { depth: 1.15, bevelEnabled: false });
  deckGeo.rotateX(-Math.PI / 2);          // extrude along +Y instead of +Z
  const deck = mesh(deckGeo, MAT.steel, 0, PAD_DECK - 1.15, 0);
  pad.add(deck);

  // Four splayed legs down to the concrete.
  const legs = new Truss();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    const cx = Math.cos(a), cz = Math.sin(a);
    legs.add(cx * 8.0, PAD_DECK - 1.15, cz * 8.0, cx * 9.6, 0, cz * 9.6, 0.42);
    legs.add(cx * 8.0, PAD_DECK - 3.2, cz * 8.0,
             Math.cos(a + TAU / 4) * 8.0, PAD_DECK - 1.2, Math.sin(a + TAU / 4) * 8.0, 0.16);
  }
  pad.add(legs.build(MAT.steel));

  // Flame deflector: two ramps meeting on a ridge, which is why the
  // exhaust leaves the trench sideways along +/- X rather than rebounding.
  for (const s of [-1, 1]) {
    const ramp = mesh(new THREE.BoxGeometry(11, 0.9, 13), MAT.dark, s * 5.4, 2.1, 0);
    ramp.rotation.z = s * 0.62;
    pad.add(ramp);
  }
  // Trench mouths: dark recesses the flow pours out of.
  for (const s of [-1, 1]) {
    pad.add(mesh(new THREE.BoxGeometry(9, 3.2, 13.6), MAT.dark, s * 14.5, 1.4, 0));
  }

  // Hold-down clamps. Four blocks gripping the base; they swing clear the
  // instant the count reaches zero.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    const pivot = new THREE.Group();
    pivot.position.set(Math.cos(a) * 4.0, PAD_DECK, Math.sin(a) * 4.0);
    pivot.rotation.y = -a;
    const arm = mesh(new THREE.BoxGeometry(2.3, 0.55, 0.8), MAT.metal, -1.3, 0.9, 0);
    pivot.add(arm);
    pivot.add(mesh(new THREE.BoxGeometry(0.8, 1.9, 1.0), MAT.steel, 0.2, 0.95, 0));
    pad.add(pivot);
    clamps.push(pivot);
  }
})();

/* --- strongback (transporter-erector) ---
   A lattice mast standing clear of the vehicle on a base hinge. It holds
   three umbilical arms that retract at T-0, then the whole tower tips
   back after release. */
const strongback = new THREE.Group();
strongback.position.set(-9.2, 0, 0);
pad.add(strongback);

const umbilicals = [];
(function buildStrongback() {
  const W = 1.05, D = 1.35, TOP = 63, BAY = 4.2;
  const t = new Truss();
  const chord = [[-D, -W], [D, -W], [D, W], [-D, W]];

  for (let b = 0; b * BAY < TOP; b++) {
    const y0 = b * BAY, y1 = Math.min(TOP, y0 + BAY);
    for (let i = 0; i < 4; i++) {
      const [x, z] = chord[i];
      t.add(x, y0, z, x, y1, z, 0.13);                       // vertical chords
      const [nx, nz] = chord[(i + 1) % 4];
      t.add(x, y1, z, nx, y1, nz, 0.09);                     // ring at each bay
      // Alternating diagonals: the brace flips every bay, which is what
      // makes a real truss read as a truss and not a ladder.
      if ((b + i) % 2 === 0) t.add(x, y0, z, nx, y1, nz, 0.075);
      else                   t.add(nx, y0, nz, x, y1, z, 0.075);
    }
  }
  strongback.add(t.build(MAT.paint));

  // Hinge barrel and two hydraulic rams.
  const hinge = mesh(new THREE.CylinderGeometry(0.85, 0.85, 3.6, 16), MAT.steel, 0, 0.9, 0);
  hinge.rotation.x = Math.PI / 2;
  strongback.add(hinge);
  for (const s of [-1, 1]) {
    const ram = mesh(new THREE.CylinderGeometry(0.4, 0.4, 9.5, 12), MAT.metal, -3.0, 5.0, s * 2.1);
    ram.rotation.z = 0.55;
    strongback.add(ram);
  }

  // Umbilical arms reaching across to the vehicle.
  for (const y of [11.5, 29.0, 44.5]) {
    const arm = new THREE.Group();
    arm.position.set(D, y, 0);
    const beam = mesh(new THREE.BoxGeometry(6.4, 0.7, 1.5), MAT.paint, 3.2, 0, 0);
    arm.add(beam);
    arm.add(mesh(new THREE.BoxGeometry(0.9, 1.5, 2.1), MAT.metal, 6.3, 0, 0));
    // Cryogenic lines slung under the beam.
    for (const z of [-0.45, 0.45]) {
      const line = mesh(new THREE.CylinderGeometry(0.17, 0.17, 6.0, 8), MAT.copper, 3.2, -0.55, z);
      line.rotation.z = Math.PI / 2;
      arm.add(line);
    }
    strongback.add(arm);
    umbilicals.push(arm);
  }
})();

/* --- lightning masts, catenary wires, and a few ground buildings so the
   vehicle has something to be 70 m tall next to. */
(function buildSurroundings() {
  const tops = [];
  const t = new Truss();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.5;
    const cx = Math.cos(a) * 155, cz = Math.sin(a) * 155;
    const H = 168, S = 3.4;
    const legsXZ = [[-S, -S], [S, -S], [S, S], [-S, S]];
    for (let b = 0; b < 21; b++) {
      const y0 = b * 8, y1 = y0 + 8;
      // The mast tapers, so each bay's footprint shrinks with height.
      const k0 = 1 - y0 / (H * 1.5), k1 = 1 - y1 / (H * 1.5);
      for (let j = 0; j < 4; j++) {
        const [x, z] = legsXZ[j], [nx, nz] = legsXZ[(j + 1) % 4];
        t.add(cx + x * k0, y0, cz + z * k0, cx + x * k1, y1, cz + z * k1, 0.3);
        t.add(cx + x * k1, y1, cz + z * k1, cx + nx * k1, y1, cz + nz * k1, 0.2);
        if ((b + j) % 2 === 0) t.add(cx + x * k0, y0, cz + z * k0, cx + nx * k1, y1, cz + nz * k1, 0.16);
      }
    }
    // Air terminal on top.
    t.add(cx, H, cz, cx, H + 14, cz, 0.22);
    tops.push(new Vector3(cx, H + 14, cz));
  }
  pad.add(t.build(MAT.paint));

  // Catenary between the masts: y = a*cosh((x-x0)/a) sags by the cable's
  // own weight. Approximated here with the parabola that matches it for
  // shallow sag, which is visually identical at this span.
  const wire = new THREE.LineBasicMaterial({ color: 0x2a2f36 });
  for (let i = 0; i < 3; i++) {
    const A = tops[i], B = tops[(i + 1) % 3];
    const pts = [];
    for (let k = 0; k <= 24; k++) {
      const u = k / 24;
      const p = A.clone().lerp(B, u);
      p.y -= 34 * 4 * u * (1 - u);          // parabolic sag, 34 m at midspan
      pts.push(p);
    }
    pad.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wire));
  }

  // Water tower, a propellant sphere and two blockhouses.
  const tank = mesh(new THREE.CylinderGeometry(9, 9, 22, 20), MAT.paint, -120, 27, 95);
  pad.add(tank);
  pad.add(mesh(new THREE.CylinderGeometry(1.1, 1.1, 32, 8), MAT.steel, -120, 16, 95));
  pad.add(mesh(new THREE.SphereGeometry(11, 24, 16), MAT.metal, 135, 13, -70));
  pad.add(mesh(new THREE.BoxGeometry(46, 9, 24), MAT.paint, 95, 4.5, 120));
  pad.add(mesh(new THREE.BoxGeometry(26, 7, 18), MAT.paint, -85, 3.5, -130));
})();
