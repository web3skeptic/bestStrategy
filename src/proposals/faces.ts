// FACE PROPOSALS — alternatives to the single shared angry face every
// humanoid wears today. Each style draws onto the 512x512 skin canvas mapped
// to the head's front. Previewed at /face-proposals. Farmers are meant to
// read happier and more innocent; a couple of fiercer options are included
// for Nomads.
import { FaceStyle, drawBrow, roundRect } from '../voxelWarrior';

const INK = '#1d1d1d', WHITE = '#fbf7ee', BLUSH = 'rgba(232,120,110,0.55)', TEETH = '#f6f2e8';

function dot(x: CanvasRenderingContext2D, px: number, py: number, r: number, color = INK): void {
  x.fillStyle = color; x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
}
function glint(x: CanvasRenderingContext2D, px: number, py: number, r: number): void { dot(x, px, py, r, WHITE); }
function blush(x: CanvasRenderingContext2D, s: number, y = 0.6, r = 0.085): void {
  dot(x, s * 0.2, s * y, s * r, BLUSH); dot(x, s * 0.8, s * y, s * r, BLUSH);
}
// smile: arc from left to right, `open` > 0 adds a filled mouth
function smile(x: CanvasRenderingContext2D, s: number, cx: number, cy: number, w: number, depth: number, lw: number): void {
  x.strokeStyle = INK; x.lineWidth = s * lw; x.lineCap = 'round';
  x.beginPath(); x.moveTo(s * (cx - w / 2), s * cy); x.quadraticCurveTo(s * cx, s * (cy + depth * 2), s * (cx + w / 2), s * cy); x.stroke();
}
function happyEye(x: CanvasRenderingContext2D, s: number, cx: number, cy: number, w: number): void { // ^ shaped closed eye
  x.strokeStyle = INK; x.lineWidth = s * 0.06; x.lineCap = 'round';
  x.beginPath(); x.moveTo(s * (cx - w / 2), s * (cy + 0.04)); x.quadraticCurveTo(s * cx, s * (cy - 0.07), s * (cx + w / 2), s * (cy + 0.04)); x.stroke();
}
function bigEye(x: CanvasRenderingContext2D, s: number, cx: number, cy: number, r: number): void {
  dot(x, s * cx, s * cy, s * r, WHITE);
  dot(x, s * cx, s * (cy + 0.01), s * r * 0.6);
  glint(x, s * (cx - r * 0.3), s * (cy - r * 0.35), s * r * 0.22);
}

export interface FaceOption { id: string; name: string; blurb: string; draw: FaceStyle; }

// A · Sunny: dot eyes with a glint, big open smile, blush.
const sunny: FaceStyle = (x, s) => {
  dot(x, s * 0.36, s * 0.42, s * 0.055); dot(x, s * 0.64, s * 0.42, s * 0.055);
  glint(x, s * 0.345, s * 0.405, s * 0.018); glint(x, s * 0.625, s * 0.405, s * 0.018);
  smile(x, s, 0.5, 0.66, 0.34, 0.09, 0.05);
  blush(x, s);
};

// B · Wide-eyed: big round eyes with white, small closed smile — innocent.
const wideEyed: FaceStyle = (x, s) => {
  bigEye(x, s, 0.35, 0.44, 0.1); bigEye(x, s, 0.65, 0.44, 0.1);
  smile(x, s, 0.5, 0.7, 0.2, 0.05, 0.045);
  blush(x, s, 0.62, 0.07);
};

// C · Grin: oval eyes, wide open grin with a row of teeth.
const grin: FaceStyle = (x, s) => {
  x.fillStyle = INK;
  x.beginPath(); x.ellipse(s * 0.36, s * 0.42, s * 0.045, s * 0.065, 0, 0, Math.PI * 2); x.fill();
  x.beginPath(); x.ellipse(s * 0.64, s * 0.42, s * 0.045, s * 0.065, 0, 0, Math.PI * 2); x.fill();
  glint(x, s * 0.35, s * 0.4, s * 0.016); glint(x, s * 0.63, s * 0.4, s * 0.016);
  x.fillStyle = INK; x.beginPath(); x.moveTo(s * 0.3, s * 0.66); x.quadraticCurveTo(s * 0.5, s * 0.92, s * 0.7, s * 0.66); x.closePath(); x.fill();
  x.fillStyle = TEETH; roundRect(x, s * 0.34, s * 0.665, s * 0.32, s * 0.06, s * 0.02); x.fill();
  blush(x, s, 0.6, 0.075);
};

// D · Content: closed happy (^ ^) eyes, soft smile, blush — the calm farmer.
const content: FaceStyle = (x, s) => {
  happyEye(x, s, 0.35, 0.44, 0.17); happyEye(x, s, 0.65, 0.44, 0.17);
  smile(x, s, 0.5, 0.7, 0.26, 0.06, 0.05);
  blush(x, s, 0.6, 0.08);
};

// E · Farm kid: dot eyes, raised gentle brows, small smile, freckles.
const farmKid: FaceStyle = (x, s) => {
  x.fillStyle = INK;
  drawBrow(x, s * 0.36, s * 0.3, -0.18, s * 0.16, s * 0.045);
  drawBrow(x, s * 0.64, s * 0.3, 0.18, s * 0.16, s * 0.045);
  dot(x, s * 0.36, s * 0.44, s * 0.05); dot(x, s * 0.64, s * 0.44, s * 0.05);
  glint(x, s * 0.35, s * 0.425, s * 0.016); glint(x, s * 0.63, s * 0.425, s * 0.016);
  smile(x, s, 0.5, 0.7, 0.22, 0.05, 0.045);
  for (const [fx, fy] of [[0.22, 0.56], [0.27, 0.6], [0.2, 0.63], [0.78, 0.56], [0.73, 0.6], [0.8, 0.63]]) dot(x, s * fx, s * fy, s * 0.012, 'rgba(120,70,30,0.6)');
};

// F · Kind & steady: straight brows, dot eyes, slight smile — friendly but adult.
const kind: FaceStyle = (x, s) => {
  x.fillStyle = INK;
  drawBrow(x, s * 0.36, s * 0.31, 0, s * 0.2, s * 0.05);
  drawBrow(x, s * 0.64, s * 0.31, 0, s * 0.2, s * 0.05);
  dot(x, s * 0.36, s * 0.44, s * 0.045); dot(x, s * 0.64, s * 0.44, s * 0.045);
  smile(x, s, 0.5, 0.71, 0.2, 0.035, 0.045);
};

// G · Fierce (Nomads): angled brows, narrow eyes, gritted teeth.
const fierce: FaceStyle = (x, s) => {
  x.fillStyle = INK;
  drawBrow(x, s * 0.355, s * 0.36, 0.42, s * 0.26, s * 0.08);
  drawBrow(x, s * 0.645, s * 0.36, -0.42, s * 0.26, s * 0.08);
  roundRect(x, s * 0.28, s * 0.45, s * 0.15, s * 0.05, s * 0.02); x.fill();
  roundRect(x, s * 0.57, s * 0.45, s * 0.15, s * 0.05, s * 0.02); x.fill();
  roundRect(x, s * 0.33, s * 0.7, s * 0.34, s * 0.12, s * 0.03); x.fill();
  x.fillStyle = TEETH; roundRect(x, s * 0.36, s * 0.73, s * 0.28, s * 0.05, s * 0.015); x.fill();
  x.fillStyle = INK; for (let i = 1; i < 4; i++) x.fillRect(s * (0.36 + i * 0.07) - 1, s * 0.73, 2, s * 0.05);
};

// H · War paint (Nomads): the fierce face plus red paint stripes under the eyes.
const warPaint: FaceStyle = (x, s) => {
  fierce(x, s);
  x.fillStyle = 'rgba(190,40,40,0.85)';
  for (const cx of [0.36, 0.64]) { x.fillRect(s * (cx - 0.1), s * 0.53, s * 0.2, s * 0.035); x.fillRect(s * (cx - 0.07), s * 0.585, s * 0.14, s * 0.03); }
};

export const FACES: FaceOption[] = [
  { id: 'sunny', name: 'A · Sunny', blurb: 'Dot eyes with a glint, big open smile, rosy cheeks.', draw: sunny },
  { id: 'wide', name: 'B · Wide-eyed', blurb: 'Big round eyes with whites and a small closed smile — the innocent one.', draw: wideEyed },
  { id: 'grin', name: 'C · Grin', blurb: 'Oval eyes and a wide open grin showing a row of teeth.', draw: grin },
  { id: 'content', name: 'D · Content', blurb: 'Closed happy eyes (^ ^), soft smile, blush — calm and pleased.', draw: content },
  { id: 'kid', name: 'E · Farm kid', blurb: 'Dot eyes, gentle raised brows, small smile and freckles.', draw: farmKid },
  { id: 'kind', name: 'F · Kind & steady', blurb: 'Straight brows, dot eyes, slight smile — friendly but grown-up.', draw: kind },
  { id: 'fierce', name: 'G · Fierce (Nomads)', blurb: 'Angled brows, narrowed eyes, gritted teeth — a sharper version of today.', draw: fierce },
  { id: 'paint', name: 'H · War paint (Nomads)', blurb: 'The fierce face with red paint stripes under the eyes.', draw: warPaint },
];
