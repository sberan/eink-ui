import { useLayoutEffect, useRef } from 'react';
import { registerKeys } from './index.js';

/**
 * Keyboard focus: the most recently mounted component calling useKeys owns the
 * key stream until it unmounts. The handler is held in a ref so re-renders do
 * not re-register (and therefore do not steal focus from a later mount).
 */
export function useKeys(handler: (key: string) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useLayoutEffect(() => registerKeys((key) => ref.current(key)), []);
}
