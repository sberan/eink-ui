import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { BatteryState, EinkStyleProp, TextAlign } from '../host/eink.js';
import type { EinkBoxIntrinsicProps, TapHandler } from '../global.js';
import { formatClock, useBattery, useClock, usePower } from '../device/index.js';

// All `style` objects use the snake_case Taffy subset from docs/ARCHITECTURE.md.

export type ViewProps = EinkBoxIntrinsicProps;

export const View = memo(function View({ style, children, ...rest }: ViewProps) {
  return <eink-box style={style} {...rest}>{children}</eink-box>;
});

export const Row = memo(function Row({ style, children, ...rest }: ViewProps) {
  return <eink-box style={{ flex_direction: 'row', ...style }} {...rest}>{children}</eink-box>;
});

export const Column = memo(function Column({ style, children, ...rest }: ViewProps) {
  return <eink-box style={{ flex_direction: 'column', ...style }} {...rest}>{children}</eink-box>;
});

export interface TextProps {
  children?: string | number | undefined;
  text?: string | undefined;
  style?: EinkStyleProp | undefined;
  font_size?: number | undefined;
  bold?: boolean | undefined;
  color?: number | undefined;
  align?: TextAlign | undefined;
  bg?: number | null | undefined;
  hit?: boolean | undefined;
  onTap?: TapHandler | undefined;
}

export const Text = memo(function Text({ children, text, ...rest }: TextProps) {
  return <eink-text text={text ?? (children === undefined ? undefined : String(children))} {...rest} />;
});

const BTN_BORDER = 2;

export interface ButtonProps {
  label: string;
  onTap?: TapHandler | undefined;
  style?: EinkStyleProp | undefined;
  font_size?: number;
  bold?: boolean;
  /** How long the pressed background is held, in ms. */
  flash?: number;
  bg?: number;
  pressedBg?: number;
  color?: number;
  pressedColor?: number;
  disabled?: boolean;
}

/**
 * Bordered box with a centred label. Pressed feedback is a bg flip held for
 * `flash` ms - the Kindle only reports a completed tap, not down/up.
 */
export const Button = memo(function Button({
  label, onTap, style, font_size = 32, bold = false, flash = 140,
  bg = 255, pressedBg = 60, color = 0, pressedColor = 255, disabled = false,
}: ButtonProps) {
  const [pressed, setPressed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  const handle = useCallback<TapHandler>((ev) => {
    if (disabled) return;
    setPressed(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; setPressed(false); }, flash);
    onTap?.(ev);
  }, [onTap, disabled, flash]);

  return (
    <eink-box
      hit
      onTap={handle}
      bg={pressed ? pressedBg : bg}
      border={BTN_BORDER}
      border_color={0}
      style={{ align_items: 'center', justify_content: 'center', ...style }}
    >
      <eink-text
        text={label}
        font_size={font_size}
        bold={bold}
        align="center"
        color={pressed ? pressedColor : color}
      />
    </eink-box>
  );
});

export const CHECKBOX_SIZE = 30;

export interface CheckboxProps {
  checked: boolean;
  label?: string | undefined;
  onTap?: TapHandler | undefined;
  size?: number;
  font_size?: number;
  gap?: number;
  style?: EinkStyleProp | undefined;
  color?: number;
}

export const Checkbox = memo(function Checkbox({
  checked, label, onTap, size = CHECKBOX_SIZE, font_size = 32, gap = 16, style, color = 0,
}: CheckboxProps) {
  return (
    <eink-box
      hit
      onTap={onTap}
      style={{ flex_direction: 'row', align_items: 'center', gap, ...style }}
    >
      <eink-box
        border={3}
        border_color={0}
        bg={checked ? 0 : 255}
        style={{ width: size, height: size, min_width: size }}
      />
      {label !== undefined && (
        <eink-text text={label} font_size={font_size} color={color} />
      )}
    </eink-box>
  );
});

export interface GridProps {
  cols: number;
  rows: number;
  /** Row height in px; cell widths come from the children. */
  cell: number;
  gap?: number;
  children?: ReactNode;
  style?: EinkStyleProp | undefined;
}

/** Fixed-pitch grid: children are laid out in reading order, cols per row. */
export const Grid = memo(function Grid({ cols, rows, cell, gap = 0, children, style }: GridProps) {
  const kids = React.Children.toArray(children);
  const out: ReactNode[] = [];
  for (let r = 0; r < rows; r++) {
    const row: ReactNode[] = [];
    for (let c = 0; c < cols; c++) row.push(kids[r * cols + c]);
    out.push(
      <eink-box key={r} style={{ flex_direction: 'row', gap, height: cell }}>{row}</eink-box>,
    );
  }
  return <eink-box style={{ flex_direction: 'column', gap, ...style }}>{out}</eink-box>;
});

// ---- on-screen keyboard ---------------------------------------------------

export const KEYBOARD_HEIGHT = 380;
const KEY_H = 82;
const KEY_GAP = 8;
const KB_PAD = 12;

/** What a key emits: a letter, or one of these control names. */
export type KeyValue = string;
export type KeyHandler = (key: KeyValue) => void;

const ROWS: readonly (readonly string[])[] = [
  'QWERTYUIOP'.split(''),
  'ASDFGHJKL'.split(''),
  'ZXCVBNM'.split(''),
];

interface KeyProps {
  label: string;
  value: KeyValue;
  onKey: KeyHandler;
  grow?: number;
  font_size?: number;
}

const Key = memo(function Key({ label, value, onKey, grow = 1, font_size = 34 }: KeyProps) {
  const tap = useCallback(() => onKey(value), [onKey, value]);
  return (
    <Button
      label={label}
      onTap={tap}
      font_size={font_size}
      style={{ flex_grow: grow, flex_basis: 0, height: KEY_H }}
    />
  );
});

export interface KeyboardProps {
  onKey?: KeyHandler | undefined;
  style?: EinkStyleProp | undefined;
}

/** QWERTY keyboard, ~380px tall. Emits onKey(letter | "BACKSPACE" | " " | "ENTER"). */
export const Keyboard = memo(function Keyboard({ onKey, style }: KeyboardProps) {
  const emit = useCallback<KeyHandler>((v) => { onKey?.(v); }, [onKey]);
  return (
    <eink-box
      bg={255}
      style={{
        flex_direction: 'column', height: KEYBOARD_HEIGHT, padding: KB_PAD,
        gap: KEY_GAP, ...style,
      }}
    >
      {ROWS.map((row, i) => (
        <eink-box key={i} style={{ flex_direction: 'row', gap: KEY_GAP, height: KEY_H }}>
          {row.map((k) => <Key key={k} label={k} value={k} onKey={emit} />)}
          {i === 2 && <Key key="bs" label="del" value="BACKSPACE" onKey={emit} grow={2} font_size={28} />}
        </eink-box>
      ))}
      <eink-box style={{ flex_direction: 'row', gap: KEY_GAP, height: KEY_H }}>
        <Key label="space" value=" " onKey={emit} grow={6} font_size={28} />
        <Key label="enter" value="ENTER" onKey={emit} grow={2} font_size={28} />
      </eink-box>
    </eink-box>
  );
});

export { Markdown, parseMarkdown, toggleTaskLine, inlineText, TASK_ROW } from './markdown.js';
export type { MarkdownProps, MdBlock } from './markdown.js';

// ---- StatusBar --------------------------------------------------------------

export const STATUS_BAR_HEIGHT = 40;

export interface StatusBarProps {
  /** Left-aligned text, e.g. the app name or a sync note. */
  title?: string | undefined;
  /** Override the live values (stories, tests); otherwise read from the host every minute. */
  battery?: BatteryState | undefined;
  time?: Date | undefined;
  color?: number | undefined;
  font_size?: number | undefined;
  style?: EinkStyleProp | undefined;
  onTap?: TapHandler | undefined;
}

const GLYPH_W = 36;
const GLYPH_H = 18;

function BatteryGlyph({ percent, charging, color }: { percent: number; charging: boolean; color: number }) {
  const inner = Math.round((Math.max(0, Math.min(100, percent)) / 100) * (GLYPH_W - 8));
  return (
    <eink-box style={{ flex_direction: 'row', align_items: 'center' }}>
      <eink-box
        border={2}
        border_color={color}
        radius={3}
        style={{ width: GLYPH_W, height: GLYPH_H, padding: 3, flex_direction: 'row', align_items: 'center' }}
      >
        <eink-box bg={color} style={{ width: inner, height: GLYPH_H - 8 }} />
      </eink-box>
      <eink-box bg={color} style={{ width: 3, height: 8 }} />
      {charging ? <eink-text text="+" font_size={22} bold color={color} style={{ margin: [0, 0, 0, 4] }} /> : null}
    </eink-box>
  );
}

/** One thin row: title on the left, clock and battery on the right. Re-renders on the minute. */
export const StatusBar = memo(function StatusBar({
  title, battery, time, color = 0, font_size = 24, style, onTap,
}: StatusBarProps) {
  const live = useBattery();
  const clock = useClock();
  const power = usePower();
  const b = battery ?? live;
  const t = time ?? clock;
  const shown = power === 'sleep' ? 'asleep · power button wakes' : (title ?? '');
  return (
    <eink-box
      onTap={onTap}
      style={{ height: STATUS_BAR_HEIGHT, flex_direction: 'row', align_items: 'center', gap: 10, ...style }}
    >
      <eink-text text={shown} font_size={font_size} color={color} bold={power === 'sleep'} style={{ flex_grow: 1 }} />
      <eink-text text={formatClock(t)} font_size={font_size} color={color} />
      <BatteryGlyph percent={b.percent} charging={b.charging} color={color} />
      <eink-text text={`${Math.round(b.percent)}%`} font_size={font_size} color={color} />
    </eink-box>
  );
});
