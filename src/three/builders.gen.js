// Per-element 3D primitive builders for the hex game.
//
// GENERATED from the "voxelize-game-elements" workflow: one agent designed each
// builder, a second reviewed it for contract-conformance + draw-call/perf. Do not
// hand-edit; re-run the workflow to regenerate.
//
// Contract: tiles  -> build_X(THREE, P)        returns THREE.Object3D
//           others -> build_X(THREE, P, color) returns THREE.Object3D
// P = { HEX_R, TILE_H, colors, mat(hex, rough) }. Tile top sits at y = 0.

export function build_tilePlain(THREE, P) {
  var root = new THREE.Group();

  // Darker, more muted grass used only for plain + hill tiles (keeps forest etc. unchanged).
  var darkGrass = 0x2a4722;

  // --- Hex prism (top face at y = 0) ---
  var prismGeo = new THREE.CylinderGeometry(P.HEX_R, P.HEX_R, P.TILE_H, 6);
  var prismMesh = new THREE.Mesh(prismGeo, P.mat(darkGrass, 0.95));
  prismMesh.rotation.y = Math.PI / 6; // pointy-top
  prismMesh.position.y = -P.TILE_H / 2;
  prismMesh.receiveShadow = true;
  root.add(prismMesh);

  // --- Randomly scattered flowers + grass so every plain tile looks different.
  // Shared geometries/materials (created once, reused for every scattered prop).
  var stemGeo = new THREE.CylinderGeometry(0.018, 0.024, 0.12, 5);
  var bloomGeo = new THREE.SphereGeometry(0.07, 8, 6);
  var bladeGeo = new THREE.ConeGeometry(0.045, 0.12, 4);
  var stemMat = P.mat(0x2c5523, 0.9);
  var bladeMat = P.mat(P.colors.leaf, 0.9);
  // white / purple / red / yellow / pink — like the reference flower tiles
  var bloomColors = [0xffffff, 0x9a6fd0, 0xd23b3b, 0xf0d000, 0xe487c8];

  function spot() {
    var a = Math.random() * Math.PI * 2;
    var r = 0.16 + Math.random() * 0.54; // within the tile, away from the very edge
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  }

  // 2–3 flowers (stem + colored bloom)
  var nFlowers = 2 + Math.floor(Math.random() * 2);
  for (var i = 0; i < nFlowers; i++) {
    var fp = spot();
    var stem = new THREE.Mesh(stemGeo, stemMat);
    stem.position.set(fp.x, 0.06, fp.z);
    stem.castShadow = true;
    root.add(stem);
    var bloom = new THREE.Mesh(bloomGeo, P.mat(bloomColors[Math.floor(Math.random() * bloomColors.length)], 0.7));
    bloom.position.set(fp.x, 0.13, fp.z);
    bloom.scale.y = 0.7;
    bloom.castShadow = true;
    root.add(bloom);
  }

  // 1–2 grass tufts
  var nGrass = 1 + Math.floor(Math.random() * 2);
  for (var j = 0; j < nGrass; j++) {
    var gp = spot();
    var blade = new THREE.Mesh(bladeGeo, bladeMat);
    blade.position.set(gp.x, 0.06, gp.z);
    blade.rotation.y = Math.random() * Math.PI;
    blade.castShadow = true;
    root.add(blade);
  }

  return root;
}

export function build_tileForest(THREE, P) {
  var root = new THREE.Group();

  // --- Tile prism ---
  var prismGeo = new THREE.CylinderGeometry(P.HEX_R, P.HEX_R, P.TILE_H, 6);
  var prismMesh = new THREE.Mesh(prismGeo, P.mat(P.colors.grass, 0.9));
  prismMesh.rotation.y = Math.PI / 6;
  prismMesh.position.y = -P.TILE_H / 2;
  prismMesh.receiveShadow = true;
  root.add(prismMesh);

  // --- Shared geometries (created once, reused) ---
  var trunkGeo = new THREE.CylinderGeometry(0.045, 0.06, 0.28, 5);
  var foliageGeo = new THREE.ConeGeometry(0.22, 0.52, 6);

  // --- Shared cached materials ---
  var trunkMat = P.mat(P.colors.wood, 0.95);
  var foliageMat = P.mat(P.colors.leaf, 0.85);

  // Three trees, each in its own group so it can get a little random size +
  // rotation so forests don't all look identical. All within radius 0.85.
  var treeData = [
    { x: -0.28, z: -0.16 },
    { x:  0.28, z:  0.22 },
    { x:  0.04, z: -0.40 }
  ];

  for (var i = 0; i < treeData.length; i++) {
    var tree = new THREE.Group();

    // Trunk: bottom at y=0, top at y=0.28
    var trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.set(0, 0.14, 0);
    trunk.castShadow = true;
    tree.add(trunk);

    // Foliage cone: base sits at top of trunk (y=0.28); +0.26 = half cone height
    var foliage = new THREE.Mesh(foliageGeo, foliageMat);
    foliage.position.set(0, 0.28 + 0.26, 0);
    foliage.castShadow = true;
    tree.add(foliage);

    var s = 0.82 + Math.random() * 0.45;
    tree.scale.set(s, s, s);
    tree.rotation.y = Math.random() * Math.PI;
    tree.position.set(treeData[i].x, 0, treeData[i].z);
    root.add(tree);
  }

  return root;
}

export function build_tileHill(THREE, P) {
  // Hills are passable: a peaked, faceted grassy mound — "tippy" but well short
  // of the mountain's height. Slightly jittered per tile so they vary.
  var root = new THREE.Group();

  // Darker, more muted grass used only for plain + hill tiles (keeps forest etc. unchanged).
  var darkGrass = 0x2a4722;

  // Grass hex prism
  var prismGeo = new THREE.CylinderGeometry(P.HEX_R, P.HEX_R, P.TILE_H, 6);
  var prism = new THREE.Mesh(prismGeo, P.mat(darkGrass, 0.95));
  prism.rotation.y = Math.PI / 6;
  prism.position.y = -P.TILE_H / 2;
  prism.receiveShadow = true;
  root.add(prism);

  // Peaked grassy hill: a faceted cone (base on y = 0). Height ~0.6 — pointed,
  // but much lower than the mountain (~1.4).
  var hillH = 0.6;
  var hillR = 0.78;
  var hillGeo = new THREE.ConeGeometry(hillR, hillH, 7, 3);
  var pos = hillGeo.attributes.position;
  for (var i = 0; i < pos.count; i++) {
    var y = pos.getY(i);
    var t = (y + hillH / 2) / hillH; // 0 base, 1 tip
    pos.setX(i, pos.getX(i) + (Math.random() - 0.5) * 0.12 * (0.4 + t));
    pos.setZ(i, pos.getZ(i) + (Math.random() - 0.5) * 0.12 * (0.4 + t));
  }
  hillGeo.computeVertexNormals();
  var hill = new THREE.Mesh(
    hillGeo,
    new THREE.MeshStandardMaterial({ color: darkGrass, roughness: 0.95, metalness: 0, flatShading: true })
  );
  hill.position.y = hillH / 2;
  hill.rotation.y = Math.random() * Math.PI;
  hill.castShadow = true;
  hill.receiveShadow = true;
  root.add(hill);

  // A couple of small grey rocks around the base so it reads as a hill.
  var rockGeo = new THREE.SphereGeometry(0.09, 6, 5);
  var rockMat = P.mat(P.colors.rock, 0.9);
  var nRocks = 2 + Math.floor(Math.random() * 2);
  for (var k = 0; k < nRocks; k++) {
    var a = Math.random() * Math.PI * 2;
    var r = 0.5 + Math.random() * 0.22;
    var rock = new THREE.Mesh(rockGeo, rockMat);
    rock.position.set(Math.cos(a) * r, 0.05, Math.sin(a) * r);
    rock.scale.set(1, 0.7, 1);
    rock.castShadow = true;
    root.add(rock);
  }

  return root;
}

export function build_tileWall(THREE, P) {
  // The wall is the INACCESSIBLE tile: a tall dark low-poly rock mountain
  // (no face, no snow). Jittered, flat-shaded cones in dark greys, randomised
  // per tile and filling the tile so it reads as impassable.
  var root = new THREE.Group();

  // Dark stone hex prism base
  var prismGeo = new THREE.CylinderGeometry(P.HEX_R, P.HEX_R, P.TILE_H, 6);
  var prism = new THREE.Mesh(prismGeo, P.mat(0x35383f, 0.98));
  prism.rotation.y = Math.PI / 6;
  prism.position.y = -P.TILE_H / 2;
  prism.receiveShadow = true;
  root.add(prism);

  // Flat-shaded dark rock materials (facets catch the light like the reference).
  var rockMat = new THREE.MeshStandardMaterial({ color: 0x4b4f59, roughness: 1.0, metalness: 0, flatShading: true });
  var rockDark = new THREE.MeshStandardMaterial({ color: 0x383b44, roughness: 1.0, metalness: 0, flatShading: true });

  // Build one jittered, faceted peak (base sits on y = 0).
  function peak(radius, height, segs, material, jitter) {
    var geo = new THREE.ConeGeometry(radius, height, segs, 3);
    var pos = geo.attributes.position;
    for (var i = 0; i < pos.count; i++) {
      var y = pos.getY(i);
      var t = (y + height / 2) / height; // 0 at base ring, 1 at the tip
      pos.setX(i, pos.getX(i) + (Math.random() - 0.5) * jitter * (0.35 + t));
      pos.setZ(i, pos.getZ(i) + (Math.random() - 0.5) * jitter * (0.35 + t));
      pos.setY(i, y + (Math.random() - 0.5) * jitter * 0.6);
    }
    geo.computeVertexNormals();
    var m = new THREE.Mesh(geo, material);
    m.position.y = height / 2;
    m.rotation.y = Math.random() * Math.PI;
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  // Tall main summit + two lower shoulder lumps for an irregular silhouette.
  root.add(peak(0.84, 1.4, 7, rockMat, 0.18));

  var s1 = peak(0.48, 0.7, 6, rockDark, 0.15);
  s1.position.set(-0.40, 0.35, 0.24);
  root.add(s1);

  var s2 = peak(0.44, 0.6, 6, rockDark, 0.15);
  s2.position.set(0.40, 0.30, -0.26);
  root.add(s2);

  return root;
}

export function build_tileFog(THREE, P) {
  var root = new THREE.Group();

  // Single shared hex-prism geometry; dark "fog" material is cached via P.mat().
  var geo = new THREE.CylinderGeometry(P.HEX_R, P.HEX_R, P.TILE_H, 6);
  var mat = P.mat(0x0a0a0f, 1.0);

  var prism = new THREE.Mesh(geo, mat);
  prism.rotation.y = Math.PI / 6;      // pointy-top orientation
  prism.position.y = -P.TILE_H / 2;    // top face sits at y = 0
  prism.receiveShadow = true;

  root.add(prism);
  return root;
}

export function build_temple(THREE, P, color) {
  const root = new THREE.Group();

  // Geometries - each created exactly once, reused for the meshes below.
  const tier1Geo = new THREE.BoxGeometry(0.95, 0.28, 0.95);
  const tier2Geo = new THREE.BoxGeometry(0.68, 0.28, 0.68);
  const tier3Geo = new THREE.BoxGeometry(0.44, 0.28, 0.44);
  const capGeo = new THREE.SphereGeometry(0.16, 8, 6);

  // Cached materials via P.mat (never new THREE.*Material).
  const playerMat = P.mat(color, 0.75);
  const goldMat = P.mat(P.colors.gold, 0.35);

  const tierH = 0.28;
  let cursor = 0; // running top-of-stack, starts at the tile top (y = 0).

  // Tier 1 - base, bottom face rests on y = 0.
  const tier1 = new THREE.Mesh(tier1Geo, playerMat);
  tier1.position.y = cursor + tierH / 2;
  tier1.castShadow = true;
  root.add(tier1);
  cursor += tierH;

  // Tier 2 - stacked directly on tier 1.
  const tier2 = new THREE.Mesh(tier2Geo, playerMat);
  tier2.position.y = cursor + tierH / 2;
  tier2.castShadow = true;
  root.add(tier2);
  cursor += tierH;

  // Tier 3 - stacked directly on tier 2.
  const tier3 = new THREE.Mesh(tier3Geo, playerMat);
  tier3.position.y = cursor + tierH / 2;
  tier3.castShadow = true;
  root.add(tier3);
  cursor += tierH;

  // Gold orb cap resting on top of tier 3.
  const cap = new THREE.Mesh(capGeo, goldMat);
  cap.position.y = cursor + 0.16;
  cap.castShadow = true;
  root.add(cap);

  return root;
}

export function build_teleport(THREE, P, color) {
  var root = new THREE.Group();

  // Single shared disc geometry reused for outer ring, inner ring and glow core.
  // Base radius 1; per-mesh scaling shapes each one (avoids 3 near-identical geos).
  var discGeo = new THREE.CylinderGeometry(1, 1, 1, 24);

  // Outer ring - wide, thin disc.
  var outerMesh = new THREE.Mesh(discGeo, P.mat(color, 0.4));
  outerMesh.scale.set(0.65, 0.08, 0.65);
  outerMesh.position.y = 0.9;
  outerMesh.castShadow = true;
  root.add(outerMesh);

  // Inner ring - slightly smaller radius, taller, to read as a ring lip.
  var innerMesh = new THREE.Mesh(discGeo, P.mat(color, 0.3));
  innerMesh.scale.set(0.48, 0.10, 0.48);
  innerMesh.position.y = 0.9;
  innerMesh.castShadow = true;
  root.add(innerMesh);

  // Glow core - flat disc in the center of the ring.
  var coreMesh = new THREE.Mesh(discGeo, P.mat(P.colors.glow, 0.1));
  coreMesh.scale.set(0.44, 0.04, 0.44);
  coreMesh.position.y = 0.9;
  coreMesh.castShadow = true;
  root.add(coreMesh);

  // Base pedestal (hex prism, distinct taper so it keeps its own geometry).
  var baseGeo = new THREE.CylinderGeometry(0.55, 0.62, 0.18, 6);
  var baseMesh = new THREE.Mesh(baseGeo, P.mat(color, 0.7));
  baseMesh.rotation.y = Math.PI / 6;
  baseMesh.position.y = 0.09;
  baseMesh.castShadow = true;
  root.add(baseMesh);

  // Vertical support pillar connecting base to ring.
  var pillarGeo = new THREE.CylinderGeometry(0.07, 0.09, 0.72, 8);
  var pillarMesh = new THREE.Mesh(pillarGeo, P.mat(color, 0.6));
  pillarMesh.position.y = 0.54;
  pillarMesh.castShadow = true;
  root.add(pillarMesh);

  return root;
}

export function build_unitArcher(THREE, P, color) {
  const root = new THREE.Group();

  // --- shared geometries (each created exactly once, reused by sharing the ref) ---
  const gTorso  = new THREE.BoxGeometry(0.28, 0.38, 0.18);
  const gHead   = new THREE.SphereGeometry(0.13, 8, 6);
  const gLeg    = new THREE.BoxGeometry(0.11, 0.30, 0.11);
  const gArm    = new THREE.BoxGeometry(0.09, 0.26, 0.09);
  const gLimb   = new THREE.CylinderGeometry(0.02, 0.012, 0.32, 6); // bow limb (tapered)
  const gString = new THREE.CylinderGeometry(0.008, 0.008, 0.52, 4);
  const gArrow  = new THREE.CylinderGeometry(0.012, 0.012, 0.42, 5);

  // --- shared cached materials (all via P.mat) ---
  const mPlayer = P.mat(color, 0.75);
  const mWood   = P.mat(P.colors.wood, 0.95);
  const mGold   = P.mat(P.colors.gold, 0.5);

  // torso
  const torso = new THREE.Mesh(gTorso, mPlayer);
  torso.position.set(0, 0.49, 0);
  torso.castShadow = true;
  root.add(torso);

  // head
  const head = new THREE.Mesh(gHead, mPlayer);
  head.position.set(0, 0.78, 0);
  head.castShadow = true;
  root.add(head);

  // legs (bottoms rest on y = 0)
  const legL = new THREE.Mesh(gLeg, mPlayer);
  legL.position.set(-0.08, 0.15, 0);
  legL.castShadow = true;
  root.add(legL);

  const legR = new THREE.Mesh(gLeg, mPlayer);
  legR.position.set(0.08, 0.15, 0);
  legR.castShadow = true;
  root.add(legR);

  // left arm: extended forward (+Z) to hold the bow
  const armL = new THREE.Mesh(gArm, mPlayer);
  armL.position.set(-0.16, 0.55, 0.16);
  armL.rotation.x = Math.PI / 2.4;
  armL.castShadow = true;
  root.add(armL);

  // right arm: pulling the string back
  const armR = new THREE.Mesh(gArm, mPlayer);
  armR.position.set(0.16, 0.55, 0.02);
  armR.rotation.x = Math.PI / 6;
  armR.castShadow = true;
  root.add(armR);

  // --- bow (held out front-left, facing +Z), two tapered limbs forming a shallow arc ---
  const bow = new THREE.Group();
  bow.position.set(-0.18, 0.55, 0.34);

  const limbU = new THREE.Mesh(gLimb, mWood); // upper limb
  limbU.position.set(0, 0.13, -0.045);
  limbU.rotation.x = -0.5;
  limbU.castShadow = true;
  bow.add(limbU);

  const limbD = new THREE.Mesh(gLimb, mWood); // lower limb (mirrored)
  limbD.position.set(0, -0.13, -0.045);
  limbD.rotation.x = 0.5;
  limbD.castShadow = true;
  bow.add(limbD);

  // bow string (vertical, spans the two limb tips)
  const string = new THREE.Mesh(gString, mGold);
  string.castShadow = true;
  bow.add(string);

  root.add(bow);

  // --- arrow nocked on the string, pointing forward (+Z) ---
  const arrow = new THREE.Mesh(gArrow, mWood);
  arrow.position.set(-0.18, 0.55, 0.39);
  arrow.rotation.x = Math.PI / 2;
  arrow.castShadow = true;
  root.add(arrow);

  return root;
}

export function build_unitCatapult(THREE, P, color) {
  const root = new THREE.Group();

  // --- Geometries (each created once, shared/cloned via mesh reuse) ---
  const frameGeo = new THREE.BoxGeometry(0.7, 0.18, 0.55);
  const railGeo = new THREE.BoxGeometry(0.06, 0.1, 0.58); // player-colored side rail
  const wheelGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.08, 10);
  const armGeo = new THREE.BoxGeometry(0.07, 0.65, 0.07);
  const boulderGeo = new THREE.SphereGeometry(0.11, 8, 6);
  const axleGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.72, 6);

  // --- Materials (all cached via P.mat) ---
  const woodMat = P.mat(P.colors.wood, 0.95);
  const rockMat = P.mat(P.colors.rock, 0.85);
  const accentMat = P.mat(color, 0.7);

  // --- Vertical layout constants ---
  const WHEEL_R = 0.14;                 // wheel radius -> bottom rests at y = 0
  const FRAME_Y = WHEEL_R + 0.14;       // frame center raised above wheels (0.28)
  const FRAME_TOP = FRAME_Y + 0.09;     // top face of frame (0.37 center + 0.09)
  const ARM_PIVOT_Y = FRAME_TOP + 0.18; // throwing-arm center sits above frame

  // 1. Main frame body
  const frame = new THREE.Mesh(frameGeo, woodMat);
  frame.position.set(0, FRAME_Y, 0);
  frame.castShadow = true;
  root.add(frame);

  // 2. Player-colored side rails (share geometry, two meshes) mounted on frame sides
  const railL = new THREE.Mesh(railGeo, accentMat);
  railL.position.set(-0.35, FRAME_Y + 0.06, 0);
  railL.castShadow = true;
  root.add(railL);

  const railR = new THREE.Mesh(railGeo, accentMat);
  railR.position.set(0.35, FRAME_Y + 0.06, 0);
  railR.castShadow = true;
  root.add(railR);

  // 3. Axle (cylinder, horizontal along X)
  const axle = new THREE.Mesh(axleGeo, woodMat);
  axle.rotation.z = Math.PI / 2;
  axle.position.set(0, WHEEL_R, 0.15);
  axle.castShadow = true;
  root.add(axle);

  // 4. Wheels (4 wheels) -- share geometry, four meshes
  const wheelPositions = [
    [-0.35, WHEEL_R,  0.15],
    [ 0.35, WHEEL_R,  0.15],
    [-0.35, WHEEL_R, -0.15],
    [ 0.35, WHEEL_R, -0.15],
  ];
  for (let i = 0; i < wheelPositions.length; i++) {
    const p = wheelPositions[i];
    const wheel = new THREE.Mesh(wheelGeo, woodMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(p[0], p[1], p[2]);
    wheel.castShadow = true;
    root.add(wheel);
  }

  // 5. Throwing arm (angled box, loaded position, facing +Z)
  const arm = new THREE.Mesh(armGeo, woodMat);
  arm.position.set(0, ARM_PIVOT_Y, -0.1);
  arm.rotation.x = -Math.PI * 0.22;
  arm.castShadow = true;
  root.add(arm);

  // 6. Boulder resting in the cup at the arm tip
  // Arm half-length 0.325 rotated by arm.rotation.x about X gives the tip offset.
  const armHalf = 0.325;
  const tipY = Math.cos(arm.rotation.x) * armHalf;   // ~0.250
  const tipZ = Math.sin(arm.rotation.x) * armHalf;   // ~-0.207
  const boulder = new THREE.Mesh(boulderGeo, rockMat);
  boulder.position.set(0, ARM_PIVOT_Y + tipY + 0.06, -0.1 + tipZ);
  boulder.castShadow = true;
  root.add(boulder);

  return root;
}

export function build_unitHorserider(THREE, P, color) {
  const root = new THREE.Group();

  // --- Geometries (created once, reused) ---
  const bodyGeo   = new THREE.BoxGeometry(0.45, 0.22, 0.7);   // horse body
  const legGeo    = new THREE.CylinderGeometry(0.055, 0.055, 0.32, 6);
  const neckGeo   = new THREE.BoxGeometry(0.13, 0.22, 0.13);  // horse neck
  const headGeo   = new THREE.BoxGeometry(0.12, 0.12, 0.22);  // horse head
  const torsoGeo  = new THREE.BoxGeometry(0.22, 0.28, 0.18);  // rider torso
  const riderHGeo = new THREE.SphereGeometry(0.11, 6, 5);     // rider head

  // --- Materials (all via P.mat, cached) ---
  const horseMat  = P.mat(P.colors.dirt,    0.9);   // horse body, legs, neck, head
  const riderMat  = P.mat(color,            0.75);  // player-colored rider torso
  const skinMat   = P.mat(P.colors.neutral, 0.8);   // rider head

  // Horse body: legs are 0.32 tall (bottom at y=0), body bottom rests on top of legs.
  // body center y = 0.32 + 0.22/2 = 0.43
  const horseBodyY = 0.32 + 0.11;
  const bodyMesh = new THREE.Mesh(bodyGeo, horseMat);
  bodyMesh.position.set(0, horseBodyY, 0);
  bodyMesh.castShadow = true;
  root.add(bodyMesh);

  // Legs — 4 cylinders, bottom at y=0, center at y=0.16. Geometry reused.
  const legY = 0.16;
  const lx = 0.17, lz = 0.22;
  const legPositions = [
    [ lx,  lz],
    [-lx,  lz],
    [ lx, -lz],
    [-lx, -lz],
  ];
  for (let i = 0; i < 4; i++) {
    const leg = new THREE.Mesh(legGeo, horseMat);
    leg.position.set(legPositions[i][0], legY, legPositions[i][1]);
    leg.castShadow = true;
    root.add(leg);
  }

  // Horse neck (front, tilted up)
  const neckMesh = new THREE.Mesh(neckGeo, horseMat);
  neckMesh.position.set(0, horseBodyY + 0.20, 0.30);
  neckMesh.rotation.x = -0.3;
  neckMesh.castShadow = true;
  root.add(neckMesh);

  // Horse head (front, faces +Z)
  const hHeadMesh = new THREE.Mesh(headGeo, horseMat);
  hHeadMesh.position.set(0, horseBodyY + 0.32, 0.44);
  hHeadMesh.rotation.x = -0.2;
  hHeadMesh.castShadow = true;
  root.add(hHeadMesh);

  // Rider torso — sits on top of horse body, player-colored
  const torsoY = horseBodyY + 0.11 + 0.14; // horse top + half torso
  const torsoMesh = new THREE.Mesh(torsoGeo, riderMat);
  torsoMesh.position.set(0, torsoY, -0.05);
  torsoMesh.castShadow = true;
  root.add(torsoMesh);

  // Rider head
  const riderHeadY = torsoY + 0.14 + 0.11;
  const riderHeadMesh = new THREE.Mesh(riderHGeo, skinMat);
  riderHeadMesh.position.set(0, riderHeadY, -0.05);
  riderHeadMesh.castShadow = true;
  root.add(riderHeadMesh);

  return root;
}

export function build_unitHeavyknight(THREE, P, color) {
  const root = new THREE.Group();

  // Shared player-color material instances (cached via P.mat)
  const bodyMat = P.mat(color, 0.6);
  const pauldronMat = P.mat(color, 0.55);
  const legMat = P.mat(color, 0.7);
  const helmetMat = P.mat(color, 0.5);
  const shieldMat = P.mat(P.colors.stone, 0.75);

  // --- Body (bulky box, player color) ---
  const bodyGeo = new THREE.BoxGeometry(0.52, 0.58, 0.38);
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.position.set(0, 0.49, 0);
  bodyMesh.castShadow = true;
  root.add(bodyMesh);

  // --- Pauldrons / shoulder plates (one geo, cloned mesh, player color) ---
  const pauldronGeo = new THREE.BoxGeometry(0.22, 0.1, 0.34);
  const pauldronL = new THREE.Mesh(pauldronGeo, pauldronMat);
  pauldronL.position.set(-0.35, 0.68, 0);
  pauldronL.castShadow = true;
  root.add(pauldronL);

  const pauldronR = pauldronL.clone();
  pauldronR.position.set(0.35, 0.68, 0);
  root.add(pauldronR);

  // --- Legs (one geo, cloned mesh, player color) ---
  const legGeo = new THREE.BoxGeometry(0.18, 0.36, 0.2);
  const legL = new THREE.Mesh(legGeo, legMat);
  legL.position.set(-0.14, 0.18, 0); // bottom sits at y=0
  legL.castShadow = true;
  root.add(legL);

  const legR = legL.clone();
  legR.position.set(0.14, 0.18, 0);
  root.add(legR);

  // --- Helmet (sphere, player color) ---
  const helmetGeo = new THREE.SphereGeometry(0.18, 8, 6);
  const helmetMesh = new THREE.Mesh(helmetGeo, helmetMat);
  helmetMesh.position.set(0, 0.98, 0);
  helmetMesh.castShadow = true;
  root.add(helmetMesh);

  // --- Shield (flat box on left side, stone accent) ---
  const shieldGeo = new THREE.BoxGeometry(0.08, 0.42, 0.32);
  const shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
  shieldMesh.position.set(-0.36, 0.52, 0.16);
  shieldMesh.castShadow = true;
  root.add(shieldMesh);

  return root;
}

export function build_unitSpearsman(THREE, P, color) {
  var root = new THREE.Group();

  // --- Geometries (each created once, reused via shared refs) ---
  var geoHead     = new THREE.SphereGeometry(0.13, 8, 6);
  var geoTorso    = new THREE.CylinderGeometry(0.11, 0.13, 0.32, 8);
  var geoHips     = new THREE.CylinderGeometry(0.09, 0.11, 0.14, 8);
  var geoLeg      = new THREE.CylinderGeometry(0.045, 0.045, 0.30, 6);
  var geoArm      = new THREE.CylinderGeometry(0.035, 0.035, 0.26, 6);
  var geoSpear    = new THREE.CylinderGeometry(0.022, 0.022, 0.95, 6);
  var geoSpearTip = new THREE.ConeGeometry(0.05, 0.13, 6);

  // --- Materials (all via cached P.mat) ---
  var matPlayer = P.mat(color, 0.7);
  var matSkin   = P.mat(P.colors.dirt, 0.85);
  var matShaft  = P.mat(P.colors.wood, 0.9);
  var matTip    = P.mat(P.colors.rock, 0.5);

  // Layout (feet at y=0, head top ~1.36, fits height ~1.4 and radius ~0.7):
  //   legs:  center y=0.15, span 0.00 -> 0.30
  //   hips:  center y=0.37, span 0.30 -> 0.44
  //   torso: center y=0.62, span 0.46 -> 0.78
  //   head:  center y=0.93, span 0.80 -> 1.06

  // --- Left leg ---
  var legL = new THREE.Mesh(geoLeg, matPlayer);
  legL.position.set(-0.06, 0.15, 0);
  legL.castShadow = true;
  root.add(legL);

  // --- Right leg ---
  var legR = new THREE.Mesh(geoLeg, matPlayer);
  legR.position.set(0.06, 0.15, 0);
  legR.castShadow = true;
  root.add(legR);

  // --- Hips ---
  var hips = new THREE.Mesh(geoHips, matPlayer);
  hips.position.set(0, 0.37, 0);
  hips.castShadow = true;
  root.add(hips);

  // --- Torso ---
  var torso = new THREE.Mesh(geoTorso, matPlayer);
  torso.position.set(0, 0.62, 0);
  torso.castShadow = true;
  root.add(torso);

  // --- Head ---
  var head = new THREE.Mesh(geoHead, matSkin);
  head.position.set(0, 0.93, 0);
  head.castShadow = true;
  root.add(head);

  // --- Left arm (slightly raised) ---
  var armL = new THREE.Mesh(geoArm, matSkin);
  armL.position.set(-0.15, 0.66, 0);
  armL.rotation.z = 0.3;
  armL.castShadow = true;
  root.add(armL);

  // --- Right arm (gripping spear) ---
  var armR = new THREE.Mesh(geoArm, matSkin);
  armR.position.set(0.15, 0.58, 0);
  armR.rotation.z = -0.3;
  armR.castShadow = true;
  root.add(armR);

  // --- Spear shaft (vertical, held at side) ---
  var spear = new THREE.Mesh(geoSpear, matShaft);
  spear.position.set(0.20, 0.58, 0);
  spear.castShadow = true;
  root.add(spear);

  // --- Spear tip (cone, pointing up) ---
  var tip = new THREE.Mesh(geoSpearTip, matTip);
  tip.position.set(0.20, 0.58 + 0.95 / 2 + 0.065, 0);
  tip.castShadow = true;
  root.add(tip);

  return root;
}

export function build_unitHealer(THREE, P, color) {
  const root = new THREE.Group();

  // --- Geometries (each constructed ONCE; the cross bar geometry is shared
  //     between the horizontal and vertical arms via rotation) ---
  const bodyGeo  = new THREE.CylinderGeometry(0.18, 0.28, 0.72, 8);
  const headGeo  = new THREE.SphereGeometry(0.15, 8, 6);
  const hoodGeo  = new THREE.ConeGeometry(0.19, 0.22, 8);
  const handGeo  = new THREE.SphereGeometry(0.07, 6, 4);
  const staffGeo = new THREE.CylinderGeometry(0.025, 0.025, 1.1, 6);
  const barGeo   = new THREE.BoxGeometry(0.22, 0.055, 0.055); // reused for both cross arms

  // --- Materials (all via cached P.mat) ---
  const robeMat  = P.mat(color, 0.85);          // player-colored robe
  const skinMat  = P.mat(P.colors.dirt, 0.9);
  const staffMat = P.mat(P.colors.wood, 0.9);
  const crossMat = P.mat(P.colors.gold, 0.3);

  // Body (robe): base on y=0, top at y=0.72
  const body = new THREE.Mesh(bodyGeo, robeMat);
  body.position.y = 0.36;
  body.castShadow = true;
  root.add(body);

  // Head (sits above the robe)
  const head = new THREE.Mesh(headGeo, skinMat);
  head.position.y = 0.87;
  head.castShadow = true;
  root.add(head);

  // Hood (cone capping the head)
  const hood = new THREE.Mesh(hoodGeo, robeMat);
  hood.position.y = 1.02;
  hood.castShadow = true;
  root.add(hood);

  // Hand gripping the staff (forward-right)
  const hand = new THREE.Mesh(handGeo, skinMat);
  hand.position.set(0.22, 0.62, 0.1);
  hand.castShadow = true;
  root.add(hand);

  // Staff shaft (runs y=0.07 -> y=1.17)
  const staff = new THREE.Mesh(staffGeo, staffMat);
  staff.position.set(0.27, 0.62, 0.1);
  staff.castShadow = true;
  root.add(staff);

  // Healing cross atop the staff: horizontal arm + vertical arm (same geo, rotated)
  const crossH = new THREE.Mesh(barGeo, crossMat);
  crossH.position.set(0.27, 1.19, 0.1);
  crossH.castShadow = true;
  root.add(crossH);

  const crossV = new THREE.Mesh(barGeo, crossMat);
  crossV.position.set(0.27, 1.19, 0.1);
  crossV.rotation.z = Math.PI / 2;
  crossV.castShadow = true;
  root.add(crossV);

  return root;
}

export function build_unitDamageBooster(THREE, P, color) {
  var root = new THREE.Group();

  // Base plate (player color) -- bottom flush on y = 0
  var baseGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.08, 8);
  var baseMesh = new THREE.Mesh(baseGeo, P.mat(color, 0.9));
  baseMesh.position.y = 0.04;
  baseMesh.castShadow = true;
  root.add(baseMesh);

  // Pillar (player color) -- sits on the base plate
  var pillarGeo = new THREE.CylinderGeometry(0.18, 0.22, 0.6, 8);
  var pillarMesh = new THREE.Mesh(pillarGeo, P.mat(color, 0.8));
  pillarMesh.position.y = 0.08 + 0.3; // base top (0.08) + half pillar height
  pillarMesh.castShadow = true;
  root.add(pillarMesh);

  // Cap on top of pillar (player color)
  var capGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.07, 8);
  var capMesh = new THREE.Mesh(capGeo, P.mat(color, 0.8));
  capMesh.position.y = 0.68 + 0.035; // pillar top (0.68) + half cap height
  capMesh.castShadow = true;
  root.add(capMesh);

  // Flame - outer/base cone (orange-red)
  var flameOrangeColor = 0xff4400;
  var flameConeOuterGeo = new THREE.ConeGeometry(0.22, 0.36, 7);
  var flameConeOuterMesh = new THREE.Mesh(flameConeOuterGeo, P.mat(flameOrangeColor, 0.5));
  flameConeOuterMesh.position.y = 0.93; // cap top (0.75) + half cone height
  flameConeOuterMesh.castShadow = true;
  root.add(flameConeOuterMesh);

  // Flame - inner/top cone (bright yellow-orange, smaller)
  var flameYellowColor = 0xff8800;
  var flameConeInnerGeo = new THREE.ConeGeometry(0.13, 0.28, 7);
  var flameConeInnerMesh = new THREE.Mesh(flameConeInnerGeo, P.mat(flameYellowColor, 0.4));
  flameConeInnerMesh.position.y = 1.14;
  flameConeInnerMesh.castShadow = true;
  root.add(flameConeInnerMesh);

  // Flame - tip cone (bright glow color, smallest)
  var flameTipGeo = new THREE.ConeGeometry(0.07, 0.2, 6);
  var flameTipMesh = new THREE.Mesh(flameTipGeo, P.mat(P.colors.glow, 0.3));
  flameTipMesh.position.y = 1.32; // tip reaches ~1.42, within the ~1.4 budget
  flameTipMesh.castShadow = true;
  root.add(flameTipMesh);

  return root;
}

export function build_unitRangeBooster(THREE, P, color) {
  var root = new THREE.Group();

  // --- Geometries (created once, reused) ---
  var mastGeo = new THREE.CylinderGeometry(0.06, 0.09, 1.0, 8);
  var baseGeo = new THREE.CylinderGeometry(0.32, 0.36, 0.12, 8);
  var emitterGeo = new THREE.SphereGeometry(0.16, 10, 8);
  var ringGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.045, 16, 1, true);
  var capGeo = new THREE.SphereGeometry(0.06, 8, 6);

  // --- Materials (cached via P.mat) ---
  var stoneMat = P.mat(P.colors.stone, 0.85);
  var colorMat = P.mat(color, 0.6);
  var glowMat = P.mat(P.colors.glow, 0.1);

  // Stacking reference: base top at y = 0.12, mast height 1.0
  var baseTop = 0.12;
  var mastH = 1.0;
  var emitterR = 0.16;

  // --- Base platform (neutral stone) ---
  var baseMesh = new THREE.Mesh(baseGeo, stoneMat);
  baseMesh.position.y = 0.06; // bottom rests on y = 0
  baseMesh.castShadow = true;
  root.add(baseMesh);

  // --- Mast (player color) ---
  var mastMesh = new THREE.Mesh(mastGeo, colorMat);
  mastMesh.position.y = baseTop + mastH / 2;
  mastMesh.castShadow = true;
  root.add(mastMesh);

  // --- Glowing emitter sphere on top ---
  var emitterMesh = new THREE.Mesh(emitterGeo, glowMat);
  emitterMesh.position.y = baseTop + mastH + emitterR;
  emitterMesh.castShadow = true;
  root.add(emitterMesh);

  // --- Cap dot on very top of emitter (player color) ---
  var capMesh = new THREE.Mesh(capGeo, colorMat);
  capMesh.position.y = baseTop + mastH + emitterR + 0.1;
  capMesh.castShadow = true;
  root.add(capMesh);

  // --- Ring around the mast mid-section (player color) ---
  var ringMesh = new THREE.Mesh(ringGeo, colorMat);
  ringMesh.position.y = baseTop + mastH * 0.5;
  ringMesh.castShadow = true;
  root.add(ringMesh);

  return root;
}

