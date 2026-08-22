// A small faction-flavored banner attached to every recruited unit's model,
// on top of (never replacing) the per-player team-color body tint — the
// body says "whose unit", the banner says "which faction" (§70 asset
// policy: reuse the existing rig, add one small distinguishing accessory
// rather than building all-new geometry per faction/slot).
import * as THREE from 'three';
import type { FactionId } from './types';

function mat(color: number, rough: number, emissive = 0x000000, ei = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, emissive, emissiveIntensity: ei, flatShading: true });
}

function block(w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

// Built in normalized units — a pole planted at the model's feet (y=0) that
// rises past head height (y=1.3) so the pennant is silhouetted clear of the
// body/weapon rather than blending into them. Colors are per-faction
// constants, deliberately distinct from the PLAYER_COLORS palette so they
// never get confused with "whose unit is this".
function buildBanner(poleColor: number, pennantColor: number, trimColor?: number): THREE.Group {
  const g = new THREE.Group();
  const pole = mat(poleColor, 0.75);
  const pennant = mat(pennantColor, 0.5, pennantColor, 0.2);
  g.add(block(0.09, 1.3, 0.09, pole, 0, 0.65, 0));

  const shape = new THREE.Shape();
  shape.moveTo(0, 1.28); shape.lineTo(0.62, 1.12); shape.lineTo(0, 0.96); shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: false });
  const flag = new THREE.Mesh(geo, pennant);
  flag.position.z = -0.03;
  g.add(flag);

  if (trimColor !== undefined) {
    const trim = mat(trimColor, 0.4, trimColor, 0.25);
    g.add(block(0.15, 0.15, 0.15, trim, 0, 1.3, 0)); // finial cap
  }
  return g;
}

function buildFactionAccent(faction: FactionId): THREE.Group {
  return faction === 'agrar'
    ? buildBanner(0x5d3b1e, 0x8a6a3a)               // leather pole, weathered bronze/olive pennant
    : buildBanner(0xd8c9a8, 0x6a4a9c, 0xe7c24a);    // bone-white pole, deep violet pennant, gold finial
}

// Attaches a faction banner behind `wrap`, scaled/positioned from its own
// bounding box so it reads proportionately (and rises clear of the head)
// regardless of the underlying rig (foot soldier, mounted, siege). No-op if
// faction is unknown (pre-reveal).
export function attachFactionAccent(wrap: THREE.Group, faction: FactionId | null | undefined): void {
  if (!faction) return;
  const box = new THREE.Box3().setFromObject(wrap);
  const size = box.getSize(new THREE.Vector3());
  if (size.y <= 0) return;
  const banner = buildFactionAccent(faction);
  banner.scale.setScalar(size.y * 0.85);
  // Planted at ground level, offset to the back-side so it clears the body
  // silhouette instead of poking through it.
  banner.position.set(box.min.x - size.x * 0.05, box.min.y, box.min.z - size.z * 0.35);
  wrap.add(banner);
}
