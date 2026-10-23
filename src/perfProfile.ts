// Rendering budget per device class.
//
// Phones and tablets (touch, no hover) pay for every pixel on a high-density
// screen with a mobile GPU and thermal limits, so they get a lighter profile:
// fewer rendered pixels, cheaper shadows, and lower frame rates while nothing
// on screen is moving. Desktop keeps the full-quality settings.

const mq = (q: string): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(q).matches;

/** Phone / tablet: primary input is a finger and there is no hover. */
export const IS_TOUCH = mq('(hover: none) and (pointer: coarse)');

/** Fewer CPU cores or little memory: an older or budget phone. */
export const IS_LOW_END = IS_TOUCH && (
  (navigator.hardwareConcurrency || 8) <= 4 ||
  ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 3
);

/**
 * Render resolution multiplier. A phone's 3× screen rendered at full density
 * means ~9× the pixels of a 1× screen — the single biggest GPU cost. On touch
 * devices we cap it; the HUD/text is HTML and stays perfectly sharp anyway.
 */
export function renderPixelRatio(touchMax: number, desktopMax = 2): number {
  const dpr = window.devicePixelRatio || 1;
  const cap = IS_TOUCH ? (IS_LOW_END ? Math.min(touchMax, 1.25) : touchMax) : desktopMax;
  return Math.min(dpr, cap);
}
