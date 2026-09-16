import { describe, it, expect } from 'vitest';
import {
  overlayFor, isDone, commitStats, formatRects, EMPTY_STATS,
  DU_MS, GC16_MS, GC16_BLACK_MS, GC16_WHITE_MS, MID_GRAY,
} from '../sim/display.js';

const W = 1072;
const H = 1448;

describe('e-ink waveform', () => {
  it('DU holds mid gray for 260 ms then shows the new pixels', () => {
    expect(overlayFor('du', 0)).toBe(MID_GRAY);
    expect(overlayFor('du', DU_MS - 1)).toBe(MID_GRAY);
    expect(overlayFor('du', DU_MS)).toBe(null);
    expect(isDone('du', DU_MS)).toBe(true);
    expect(isDone('du', DU_MS - 1)).toBe(false);
  });

  it('GC16 flashes black then white then settles, 450 ms total', () => {
    expect(overlayFor('gc16', 0)).toBe('#000');
    expect(overlayFor('gc16', GC16_BLACK_MS - 1)).toBe('#000');
    expect(overlayFor('gc16', GC16_BLACK_MS)).toBe('#fff');
    expect(overlayFor('gc16', GC16_BLACK_MS + GC16_WHITE_MS - 1)).toBe('#fff');
    expect(overlayFor('gc16', GC16_BLACK_MS + GC16_WHITE_MS)).toBe(null);
    expect(isDone('gc16', GC16_MS - 1)).toBe(false);
    expect(isDone('gc16', GC16_MS)).toBe(true);
    expect(GC16_BLACK_MS + GC16_WHITE_MS).toBeLessThan(GC16_MS);
  });
});

describe('status counters', () => {
  it('counts one partial per commit with damage', () => {
    let s = EMPTY_STATS;
    for (let i = 0; i < 3; i++) s = commitStats(s, [{ x: 0, y: 0, w: 10, h: 10, mode: 'du' }], W, H);
    expect(s.partialsSinceFull).toBe(3);
  });

  it('a gc16 commit resets the counter', () => {
    let s = commitStats(EMPTY_STATS, [{ x: 0, y: 0, w: 10, h: 10, mode: 'du' }], W, H);
    s = commitStats(s, [{ x: 0, y: 0, w: W, h: H, mode: 'gc16' }], W, H);
    expect(s.partialsSinceFull).toBe(0);
    expect(s.areaPct).toBeCloseTo(100, 6);
  });

  it('an empty commit changes nothing', () => {
    const s = commitStats({ partialsSinceFull: 4, rects: [], areaPct: 0 }, [], W, H);
    expect(s.partialsSinceFull).toBe(4);
    expect(s.areaPct).toBe(0);
  });

  it('reports the refreshed area as a percentage of the panel', () => {
    const s = commitStats(EMPTY_STATS, [
      { x: 0, y: 0, w: 1072, h: 100, mode: 'du' },
      { x: 0, y: 200, w: 1072, h: 100, mode: 'du' },
    ], W, H);
    expect(s.areaPct).toBeCloseTo((1072 * 200) / (W * H) * 100, 6);
  });

  it('formats the rect list', () => {
    expect(formatRects([{ x: 1, y: 2, w: 3, h: 4, mode: 'du' }])).toBe('DU 3x4@1,2');
    expect(formatRects([])).toBe('(no damage)');
  });
});
