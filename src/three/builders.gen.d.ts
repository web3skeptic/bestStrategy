import type * as THREE from 'three';
import type { Palette } from './palette';

type T = typeof THREE;
type Obj = THREE.Object3D;

// Tiles
export function build_tilePlain(THREE: T, P: Palette): Obj;
export function build_tileForest(THREE: T, P: Palette): Obj;
export function build_tileHill(THREE: T, P: Palette): Obj;
export function build_tileWall(THREE: T, P: Palette): Obj;
export function build_tileFog(THREE: T, P: Palette): Obj;

// Structures (player/neutral colored)
export function build_temple(THREE: T, P: Palette, color: number): Obj;
export function build_teleport(THREE: T, P: Palette, color: number): Obj;

// Units (player colored)
export function build_unitArcher(THREE: T, P: Palette, color: number): Obj;
export function build_unitCatapult(THREE: T, P: Palette, color: number): Obj;
export function build_unitHorserider(THREE: T, P: Palette, color: number): Obj;
export function build_unitHeavyknight(THREE: T, P: Palette, color: number): Obj;
export function build_unitSpearsman(THREE: T, P: Palette, color: number): Obj;
export function build_unitHealer(THREE: T, P: Palette, color: number): Obj;
export function build_unitDamageBooster(THREE: T, P: Palette, color: number): Obj;
export function build_unitRangeBooster(THREE: T, P: Palette, color: number): Obj;
