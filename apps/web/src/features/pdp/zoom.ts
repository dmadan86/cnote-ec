// Pure maths for the lightbox zoom / pan (unit-tested in test/pdp-tiers.test.ts).
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 0.5;

export const clampScale = (s: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(s * 100) / 100));

/** Keeps the zoomed image covering the stage: at scale s the image may move by (s-1)/2 of the stage size either way. */
export function clampPan(x: number, y: number, scale: number, width: number, height: number): { x: number; y: number } {
  const mx = ((scale - 1) * width) / 2;
  const my = ((scale - 1) * height) / 2;
  return { x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) };
}

/** New scale for a two-finger pinch: start scale x (current finger distance / start distance). */
export function pinchScale(startScale: number, startDist: number, dist: number): number {
  return startDist > 0 ? clampScale(startScale * (dist / startDist)) : startScale;
}

/** Wrapping previous/next. */
export const nextIndex = (i: number, delta: number, total: number): number => (total <= 0 ? 0 : (((i + delta) % total) + total) % total);
