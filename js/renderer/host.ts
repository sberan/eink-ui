// Prop translation between React elements and eink_core::Props.
//
// Intrinsics: "eink-box" (Kind::Box) and "eink-text" (Kind::Text).
// Props mirror eink_core::Props exactly: style (snake_case Taffy subset), bg,
// border, border_color, color, text, font_size, bold, align, hit, radius.
// Everything else (onTap, children, key, ref) is renderer-side only.

import type {
  EinkPaintProps, EinkProps, EinkStyle, NodeKind, Sides,
} from '../host/eink.js';
import type { EinkBoxIntrinsicProps, EinkTextIntrinsicProps } from '../global.js';

export type IntrinsicType = 'eink-box' | 'eink-text';
export type IntrinsicProps = EinkBoxIntrinsicProps | EinkTextIntrinsicProps;

export const KIND: Record<IntrinsicType, NodeKind> = {
  'eink-box': 'box',
  'eink-text': 'text',
};

type PaintKey = keyof EinkPaintProps;
type StyleKey = keyof EinkStyle;

const PAINT_KEYS: readonly PaintKey[] = [
  'bg', 'border', 'border_color', 'color', 'text',
  'font_size', 'bold', 'align', 'hit', 'radius',
];

const STYLE_KEYS: readonly StyleKey[] = [
  'width', 'height', 'min_width', 'min_height', 'max_width', 'max_height',
  'flex_direction', 'flex_wrap', 'justify_content', 'align_items', 'align_self',
  'flex_grow', 'flex_shrink', 'flex_basis', 'gap', 'padding', 'margin',
  'position', 'top', 'left', 'right', 'bottom', 'display',
];

const INSET_KEYS = ['top', 'left', 'right', 'bottom'] as const;

// eink_core::Paint defaults, sent when a prop is removed
const PAINT_DEFAULTS: { [K in PaintKey]-?: EinkPaintProps[K] } = {
  bg: null, border: 0, border_color: 0, color: 0, text: '',
  font_size: 32, bold: false, align: 'left', hit: false, radius: 0,
};

// Taffy defaults, sent when a style key is removed
const STYLE_DEFAULTS: { [K in StyleKey]-?: EinkStyle[K] } = {
  width: 'auto', height: 'auto', min_width: 'auto', min_height: 'auto',
  max_width: 'auto', max_height: 'auto', flex_direction: 'column',
  flex_wrap: 'nowrap', justify_content: 'start', align_items: 'start',
  align_self: 'start', flex_grow: 0, flex_shrink: 1, flex_basis: 'auto',
  gap: 0, padding: 0, margin: 0, position: 'relative',
  top: null, left: null, right: null, bottom: null, display: 'flex',
};

/**
 * Writes one key of a partial payload. The cast is confined here: `T[K]` and the
 * value share a key, but TypeScript cannot see that through `exactOptionalPropertyTypes`.
 */
function put<T, K extends keyof T>(target: T, key: K, value: T[K]): void {
  (target as Record<K, T[K]>)[key] = value;
}

export function isTextChild(children: unknown): children is string | number {
  return typeof children === 'string' || typeof children === 'number';
}

/** A string/number child of <eink-text> is its `text` prop. */
function textOf(props: IntrinsicProps): string | undefined {
  if (props.text !== undefined) return props.text;
  if (isTextChild(props.children)) return String(props.children);
  return undefined;
}

function sameStyleValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return false;
}

/** Full payload for a freshly created node: only the keys actually present. */
export function initialPayload(type: IntrinsicType, props: IntrinsicProps): EinkProps {
  const out: EinkProps = {};
  for (const k of PAINT_KEYS) {
    const v = props[k];
    if (v !== undefined) put(out, k, v);
  }
  if (type === 'eink-text') {
    const t = textOf(props);
    if (t !== undefined) out.text = t;
  }
  const s = props.style;
  if (s) {
    const style: EinkStyle = {};
    let n = 0;
    for (const k of STYLE_KEYS) {
      const v = s[k];
      if (v !== undefined) { put(style, k, v); n++; }
    }
    if (n) out.style = style;
  }
  return out;
}

const EMPTY_STYLE: EinkStyle = {};

/**
 * Diff of two prop objects containing ONLY changed keys. `style` is included
 * only when a style key changed, and then carries only the changed keys
 * (eink-core merges partial styles). Returns null when nothing changed.
 */
export function diffProps(
  type: IntrinsicType,
  oldProps: IntrinsicProps,
  newProps: IntrinsicProps,
): EinkProps | null {
  const out: EinkProps = {};
  let changed = 0;

  for (const k of PAINT_KEYS) {
    if (k === 'text' && type === 'eink-text') continue;
    const a = oldProps[k];
    const b = newProps[k];
    if (a !== b) {
      put(out, k, b === undefined ? PAINT_DEFAULTS[k] : b);
      changed++;
    }
  }

  if (type === 'eink-text') {
    const a = textOf(oldProps);
    const b = textOf(newProps);
    if (a !== b) { out.text = b ?? ''; changed++; }
  }

  const os = oldProps.style ?? EMPTY_STYLE;
  const ns = newProps.style ?? EMPTY_STYLE;
  if (os !== ns) {
    const style: EinkStyle = {};
    let sn = 0;
    for (const k of STYLE_KEYS) {
      if (!sameStyleValue(os[k], ns[k])) {
        const v = ns[k];
        put(style, k, v === undefined ? STYLE_DEFAULTS[k] : v);
        sn++;
      }
    }
    // eink-core only rewrites `inset` when at least one side is present, and
    // then reads all four - so a change to one side must resend the whole set.
    if (sn && INSET_KEYS.some((k) => k in style)) {
      for (const k of INSET_KEYS) style[k] = ns[k] ?? null;
    }
    if (sn) { out.style = style; changed++; }
  }

  return changed ? out : null;
}

export type { Sides };
export { PAINT_KEYS, STYLE_KEYS, PAINT_DEFAULTS, STYLE_DEFAULTS };
