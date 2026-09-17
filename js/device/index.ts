// Device APIs for apps: battery, clock and the page buttons, with sensible answers when no
// host is present (tests, snapshots).
import { useEffect, useState } from 'react';
import type { BatteryState } from '../host/eink.js';
import { useKeys } from '../renderer/useKeys.js';

const NO_BATTERY: BatteryState = { percent: 100, charging: false };

export function getBattery(): BatteryState {
  const host = globalThis.__eink;
  return typeof host?.battery === 'function' ? host.battery() : NO_BATTERY;
}

/** Battery state, re-read every `every` ms while mounted. Timers pause while the device sleeps. */
export function useBattery(every = 60_000): BatteryState {
  const [state, setState] = useState(getBattery);
  useEffect(() => {
    let timer = setTimeout(function tick() {
      setState(getBattery());
      timer = setTimeout(tick, every);
    }, every);
    return () => clearTimeout(timer);
  }, [every]);
  return state;
}

/** The device's local time as a Date whose UTC fields hold local wall-clock values. */
export function localNow(): Date {
  const host = globalThis.__eink;
  const ms = typeof host?.now === 'function' ? host.now() : Date.now();
  const offset = typeof host?.tz_offset === 'function' ? host.tz_offset() : -new Date().getTimezoneOffset();
  return new Date(ms + offset * 60_000);
}

/** "9:41" from localNow(); pass a Date to format something else. */
export function formatClock(d: Date = localNow()): string {
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return `${((h + 11) % 12) + 1}:${m < 10 ? '0' : ''}${m}`;
}

/** Local wall-clock time, updated on the minute while mounted. */
export function useClock(): Date {
  const [now, setNow] = useState(localNow);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const ms = 60_000 - (localNow().getTime() % 60_000);
      timer = setTimeout(() => { setNow(localNow()); schedule(); }, ms);
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  return now;
}

export type PageButton = 'left' | 'right';

/** The Voyage's PagePress zones arrive as PageUp (left side) and PageDown (right side). */
const LEFT_KEYS = new Set(['PageUp', 'PagePrev', 'PREV', 'ArrowLeft', 'ArrowUp']);
const RIGHT_KEYS = new Set(['PageDown', 'PageNext', 'NEXT', 'ArrowRight', 'ArrowDown']);

export function pageButton(key: string): PageButton | null {
  return LEFT_KEYS.has(key) ? 'left' : RIGHT_KEYS.has(key) ? 'right' : null;
}

export interface PageButtonHandlers {
  onLeft?: (() => void) | undefined;
  onRight?: (() => void) | undefined;
}

/** Page buttons for the most recently mounted caller (same focus rule as useKeys). */
export function usePageButtons({ onLeft, onRight }: PageButtonHandlers): void {
  useKeys((key) => {
    const b = pageButton(key);
    if (b === 'left') onLeft?.();
    else if (b === 'right') onRight?.();
  });
}
