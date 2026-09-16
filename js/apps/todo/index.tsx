import React, { memo, useCallback, useMemo, useState } from 'react';
import { SAMPLE } from './sample.js';
import { isTodoList, type TodoItem, type TodoList, type TodoSection } from './schema.js';

// Metrics from the reference render (Noto Serif).
const PAGE_PAD = 36;
const HEADER_DAY = 52;
const HEADER_DATE = 30;
const SECTION_SIZE = 34;
const ROW_H = 46;
const CHECK = 30;
const ITEM_SIZE = 32;
const FOOTER_SIZE = 28;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'] as const;

export interface HeaderText { day: string; date: string }

export function formatHeader(iso: string): HeaderText {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m?.[1] || !m[2] || !m[3]) return { day: iso, date: '' };
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return {
    day: DAYS[d.getUTCDay()] ?? iso,
    date: `${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCDate()}, ${d.getUTCFullYear()}`,
  };
}

type ToggleHandler = (id: string) => void;

const Item = memo(function Item({ item, onToggle }: { item: TodoItem; onToggle: ToggleHandler }) {
  const tap = useCallback(() => onToggle(item.id), [onToggle, item.id]);
  return (
    <eink-box
      hit
      onTap={tap}
      style={{ flex_direction: 'row', align_items: 'center', height: ROW_H, gap: 18 }}
    >
      <eink-box
        border={3}
        border_color={0}
        bg={item.done ? 0 : 255}
        style={{ width: CHECK, height: CHECK, min_width: CHECK }}
      />
      <eink-text
        text={item.text}
        font_size={ITEM_SIZE}
        color={item.done ? 120 : 0}
        style={{ flex_grow: 1 }}
      />
    </eink-box>
  );
});

const Section = memo(function Section(
  { section, onToggle }: { section: TodoSection; onToggle: ToggleHandler },
) {
  return (
    <eink-box style={{ flex_direction: 'column', margin: [14, 0, 0, 0] }}>
      <eink-text
        text={section.title.toUpperCase()}
        font_size={SECTION_SIZE}
        bold
        style={{ height: SECTION_SIZE + 10 }}
      />
      {section.items.map((it) => (
        <Item key={it.id} item={it} onToggle={onToggle} />
      ))}
    </eink-box>
  );
});

function countDone(sections: readonly TodoSection[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const s of sections) {
    for (const it of s.items) { total++; if (it.done) done++; }
  }
  return { done, total };
}

/**
 * POST the flip to the server if the host exposes fetch; no-op in the simulator.
 * The API's toggle route flips server state for {date,id}, so it is called once per tap.
 */
function pushToggle(date: string, id: string, api: string): void {
  const host = globalThis.__eink;
  if (!host?.fetch || !api) return;
  try {
    host.fetch(`${api}/api/toggle`, {
      method: 'POST',
      body: JSON.stringify({ date, id }),
    });
  } catch (err) {
    // offline Kindle: the local toggle still stands
    host.log(`toggle ${id} failed: ${String(err)}`);
  }
}

export interface TodoAppProps {
  data?: TodoList | undefined;
  /** Origin of the list API (no trailing slash); empty = offline, toggles stay local. */
  api?: string;
  onHeaderTap?: (() => void) | undefined;
  onFooterTap?: (() => void) | undefined;
}

/** Resolves the list to render: the prop, then the host payload, then the sample. */
export function resolveList(data?: TodoList): TodoList {
  if (data) return data;
  const injected: unknown = globalThis.__eink_data;
  return isTodoList(injected) ? injected : SAMPLE;
}

export function TodoApp({ data, api = '', onHeaderTap, onFooterTap }: TodoAppProps) {
  const initial = useMemo(() => resolveList(data), [data]);
  const [sections, setSections] = useState<readonly TodoSection[]>(initial.sections);
  const [shownDate, setShownDate] = useState(initial.date);

  // A new day arriving as a prop must replace the local toggles, not be ignored:
  // useState only seeds on mount, which is how the page-turn buttons got stuck.
  if (shownDate !== initial.date) {
    setShownDate(initial.date);
    setSections(initial.sections);
  }

  const onToggle = useCallback<ToggleHandler>((id) => {
    setSections((prev) => prev.map((s) => {
      if (!s.items.some((it) => it.id === id)) return s;
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== id) return it;
          const next: TodoItem = { ...it, done: !it.done };
          pushToggle(initial.date, id, api);
          return next;
        }),
      };
    }));
  }, [api, initial.date]);

  const head = useMemo(() => formatHeader(initial.date), [initial.date]);
  const { done, total } = countDone(sections);

  return (
    <eink-box
      bg={255}
      style={{
        width: 1072, height: 1448, flex_direction: 'column',
        padding: [PAGE_PAD, PAGE_PAD, PAGE_PAD, PAGE_PAD],
      }}
    >
      <eink-box onTap={onHeaderTap} style={{ flex_direction: 'column' }}>
        <eink-text text={head.day} font_size={HEADER_DAY} bold style={{ height: HEADER_DAY + 12 }} />
        <eink-text text={head.date} font_size={HEADER_DATE} color={90} style={{ height: HEADER_DATE + 10 }} />
      </eink-box>
      <eink-box bg={0} style={{ height: 3, margin: [14, 0, 0, 0] }} />
      <eink-box style={{ flex_direction: 'column', flex_grow: 1 }}>
        {sections.map((s) => (
          <Section key={s.title} section={s} onToggle={onToggle} />
        ))}
      </eink-box>
      <eink-box bg={0} style={{ height: 1, margin: [0, 0, 12, 0] }} />
      <eink-box onTap={onFooterTap} style={{ flex_direction: 'column' }}>
        <eink-text
          text={`${done}/${total} done`}
          font_size={FOOTER_SIZE}
          color={90}
          align="right"
          style={{ height: FOOTER_SIZE + 8 }}
        />
      </eink-box>
    </eink-box>
  );
}

export default TodoApp;
