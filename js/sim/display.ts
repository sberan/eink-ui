// Pure display logic for the simulator: e-ink waveform phases and commit stats.
// Kept separate from sim.ts so it can be unit tested without a DOM.

import type { DamageRect, RefreshMode } from '../host/eink.js';

export const DU_MS = 260;
export const GC16_BLACK_MS = 200;
export const GC16_WHITE_MS = 150;
export const GC16_MS = 450;

export const MID_GRAY = '#8a8a8a';

/**
 * Overlay colour for a rect `dt` ms into its waveform.
 * null means "the waveform is done, show the new pixels".
 *   du   : mid gray for 260 ms
 *   gc16 : black 200 ms, white 150 ms, then the new pixels for the remaining 100 ms
 */
export function overlayFor(mode: RefreshMode, dt: number): string | null {
  if (mode === 'gc16') {
    if (dt < GC16_BLACK_MS) return '#000';
    if (dt < GC16_BLACK_MS + GC16_WHITE_MS) return '#fff';
    return null;
  }
  return dt < DU_MS ? MID_GRAY : null;
}

export function isDone(mode: RefreshMode, dt: number): boolean {
  return dt >= (mode === 'gc16' ? GC16_MS : DU_MS);
}

export interface CommitStats {
  readonly partialsSinceFull: number;
  readonly rects: readonly DamageRect[];
  readonly areaPct: number;
}

export const EMPTY_STATS: CommitStats = { partialsSinceFull: 0, rects: [], areaPct: 0 };

/**
 * Folds one commit's damage list into the status counters.
 * A gc16 rect is a full flash, so it resets the partial counter.
 */
export function commitStats(
  prev: CommitStats,
  rects: readonly DamageRect[],
  screenW: number,
  screenH: number,
): CommitStats {
  const painted = rects.reduce((a, r) => a + Math.max(0, r.w) * Math.max(0, r.h), 0);
  let partials = prev.partialsSinceFull;
  if (rects.some((r) => r.mode === 'gc16')) partials = 0;
  else if (rects.length) partials += 1;
  return {
    partialsSinceFull: partials,
    rects,
    areaPct: (painted / (screenW * screenH)) * 100,
  };
}

export function formatRects(rects: readonly DamageRect[]): string {
  if (!rects.length) return '(no damage)';
  return rects.map((r) => `${r.mode.toUpperCase()} ${r.w}x${r.h}@${r.x},${r.y}`).join('  ');
}
