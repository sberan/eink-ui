import React, { memo, useCallback } from 'react';
import type { EinkStyleProp } from '../host/eink.js';
import type { TapHandler } from '../global.js';
import { Checkbox } from './index.js';

/** The block subset the panel can draw. `line` is the source line, for edits. */
export type MdBlock =
  | { kind: 'heading'; level: number; text: string; line: number }
  | { kind: 'para'; text: string; line: number }
  | { kind: 'task'; checked: boolean; text: string; line: number; indent: number }
  | { kind: 'bullet'; text: string; line: number; indent: number }
  | { kind: 'number'; n: string; text: string; line: number; indent: number }
  | { kind: 'quote'; text: string; line: number }
  | { kind: 'hr'; line: number };

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;

/** Inline markdown the panel cannot show becomes plain text: one style per text node. */
export function inlineText(s: string): string {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](.+?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(EMOJI, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) i = end + 1;
  }
  let para: { text: string; line: number } | null = null;
  const flush = () => { if (para) { blocks.push({ kind: 'para', ...para }); para = null; } };
  for (; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.replace(/\t/g, '    ');
    const trimmed = line.trim();
    if (trimmed === '') { flush(); continue; }
    const indent = Math.floor((line.length - line.trimStart().length) / 2);
    let m: RegExpMatchArray | null;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(trimmed))) {
      flush(); blocks.push({ kind: 'heading', level: m[1]!.length, text: inlineText(m[2]!), line: i });
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush(); blocks.push({ kind: 'hr', line: i });
    } else if ((m = /^[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(trimmed))) {
      flush(); blocks.push({ kind: 'task', checked: m[1] !== ' ', text: inlineText(m[2]!), line: i, indent });
    } else if ((m = /^[-*+]\s+(.*)$/.exec(trimmed))) {
      flush(); blocks.push({ kind: 'bullet', text: inlineText(m[1]!), line: i, indent });
    } else if ((m = /^(\d+)[.)]\s+(.*)$/.exec(trimmed))) {
      flush(); blocks.push({ kind: 'number', n: m[1]!, text: inlineText(m[2]!), line: i, indent });
    } else if ((m = /^>\s?(.*)$/.exec(trimmed))) {
      flush(); blocks.push({ kind: 'quote', text: inlineText(m[1]!), line: i });
    } else if (para) {
      para.text += ' ' + inlineText(trimmed);
    } else {
      para = { text: inlineText(trimmed), line: i };
    }
  }
  flush();
  return blocks;
}

/** Flips the checkbox on one source line; other lines are untouched. */
export function toggleTaskLine(text: string, line: number): string {
  const lines = text.split('\n');
  const src = lines[line];
  if (src === undefined) return text;
  lines[line] = src.replace(/^(\s*[-*+]\s+\[)([ xX])(\])/, (_, a: string, c: string, b: string) => `${a}${c === ' ' ? 'x' : ' '}${b}`);
  return lines.join('\n');
}

export interface MarkdownProps {
  text: string;
  font_size?: number | undefined;
  color?: number | undefined;
  /** Makes task rows tappable. */
  onToggleTask?: ((line: number, checked: boolean) => void) | undefined;
  onTap?: TapHandler | undefined;
  style?: EinkStyleProp | undefined;
}

const HEADING_SIZE = [0, 52, 42, 36, 32, 32, 32];
/** Task rows tile the column with no gap between them, so a finger never lands between two. */
export const TASK_ROW = 56;

const Task = memo(function Task({ block, size, color, onToggle }: {
  block: Extract<MdBlock, { kind: 'task' }>; size: number; color: number;
  onToggle: ((line: number, checked: boolean) => void) | undefined;
}) {
  const tap = useCallback(() => onToggle?.(block.line, !block.checked), [onToggle, block.line, block.checked]);
  return (
    <Checkbox
      checked={block.checked}
      label={block.text}
      font_size={size}
      color={color}
      onTap={onToggle ? tap : undefined}
      style={{ margin: [0, 0, 0, block.indent * 28], min_height: TASK_ROW, padding: [4, 0, 4, 0] }}
    />
  );
});

/** Headings, paragraphs, bullets, numbers, quotes, rules and tappable task lists. */
export const Markdown = memo(function Markdown({
  text, font_size = 30, color = 0, onToggleTask, onTap, style,
}: MarkdownProps) {
  const blocks = parseMarkdown(text);
  const gap = Math.round(font_size * 0.4);
  const space = (i: number) => (i === 0 ? 0 : gap);
  return (
    <eink-box onTap={onTap} style={{ flex_direction: 'column', ...style }}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return <eink-text key={b.line} text={b.text} bold font_size={HEADING_SIZE[b.level] ?? 32} color={color} style={{ margin: [space(i) + (b.level === 1 ? 0 : gap), 0, 0, 0] }} />;
          case 'para':
            return <eink-text key={b.line} text={b.text} font_size={font_size} color={color} style={{ margin: [space(i), 0, 0, 0] }} />;
          case 'task':
            return <Task key={b.line} block={b} size={font_size} color={color} onToggle={onToggleTask} />;
          case 'bullet':
            return (
              <eink-box key={b.line} style={{ flex_direction: 'row', gap: 12, margin: [space(i), 0, 0, b.indent * 28] }}>
                <eink-text text="•" font_size={font_size} color={color} style={{ width: 24 }} />
                <eink-text text={b.text} font_size={font_size} color={color} style={{ flex_grow: 1, flex_shrink: 1 }} />
              </eink-box>
            );
          case 'number':
            return (
              <eink-box key={b.line} style={{ flex_direction: 'row', gap: 12, margin: [space(i), 0, 0, b.indent * 28] }}>
                <eink-text text={`${b.n}.`} font_size={font_size} color={color} style={{ width: 44 }} align="right" />
                <eink-text text={b.text} font_size={font_size} color={color} style={{ flex_grow: 1, flex_shrink: 1 }} />
              </eink-box>
            );
          case 'quote':
            return (
              <eink-box key={b.line} style={{ flex_direction: 'row', gap: 16, margin: [space(i), 0, 0, 0] }}>
                <eink-box bg={0} style={{ width: 4 }} />
                <eink-text text={b.text} font_size={font_size} color={color} style={{ flex_grow: 1, flex_shrink: 1 }} />
              </eink-box>
            );
          case 'hr':
            return <eink-box key={b.line} bg={0} style={{ height: 2, margin: [gap, 0, gap, 0] }} />;
          default:
            return null;
        }
      })}
    </eink-box>
  );
});
