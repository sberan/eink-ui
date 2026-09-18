// The all-in-one app: every component story and every demo app as pages of one app, so the
// whole kit can be walked through on a device or in the browser through the same engine.
// Navigation is the kit's own: tabs in the top right corner (previous, next, index) and an
// index screen. Page buttons and typed keys stay with the page shown, which may use them.
import React, { useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Button, Text } from '../../components/index.js';
import { useStoredState } from '../../storage/index.js';
import { STORIES } from '../../stories/index.js';
import { PANEL_H, PANEL_W } from '../../stories/kit.js';
import { CrosswordApp } from '../crossword/index.js';
import { ReaderApp } from '../reader/index.js';
import { TodoApp } from '../todo/index.js';

export interface GalleryPage {
  readonly id: string;
  readonly group: string;
  readonly name: string;
  readonly render: () => ReactElement;
}

const APP_PAGES: readonly GalleryPage[] = [
  { id: 'apps--reader', group: 'Apps', name: 'Reader', render: () => <ReaderApp /> },
  { id: 'apps--todo', group: 'Apps', name: 'Todo', render: () => <TodoApp /> },
  { id: 'apps--crossword', group: 'Apps', name: 'Crossword', render: () => <CrosswordApp /> },
];

/** Every page of the gallery, apps first, then the stories in their registry order. */
export const PAGES: readonly GalleryPage[] = [
  ...APP_PAGES,
  ...STORIES.filter((s) => s.group !== 'Reader').map((s) => ({ id: s.id, group: s.group, name: s.name, render: s.render })),
];

export function findPage(id: string): GalleryPage | undefined {
  return PAGES.find((p) => p.id === id);
}

export interface GalleryAppProps {
  /** Page id to show; when given, the gallery is controlled and reports moves through onPage. */
  page?: string | undefined;
  onPage?: ((id: string) => void) | undefined;
}

const TAB = 56;
const INDEX_TAB = 110;
const CORNER = 8;

// plain glyphs only: the bundled font has no ≡ or ☰
function Tab({ label, onTap, x, width = TAB }: { label: string; onTap: () => void; x: number; width?: number }) {
  return (
    <Button
      label={label}
      font_size={label.length > 1 ? 24 : 30}
      onTap={onTap}
      style={{ position: 'absolute', top: CORNER, right: x, width, height: TAB }}
    />
  );
}

function Index({ current, onPick }: { current: string; onPick: (id: string) => void }) {
  const groups = useMemo(() => {
    const out: { group: string; pages: GalleryPage[] }[] = [];
    for (const p of PAGES) {
      const last = out[out.length - 1];
      if (last && last.group === p.group) last.pages.push(p);
      else out.push({ group: p.group, pages: [p] });
    }
    return out;
  }, []);
  // two columns: the panel is tall but the list is long
  const half = Math.ceil(groups.length / 2);
  const columns = [groups.slice(0, half), groups.slice(half)];
  return (
    <eink-box bg={255} style={{ width: PANEL_W, height: PANEL_H, flex_direction: 'column', padding: [40, 48, 40, 48], gap: 20 }}>
      <Text font_size={44} bold>eink-ui gallery</Text>
      <Text font_size={26}>Tap a page. The corner tabs go back, forward and here.</Text>
      <eink-box style={{ flex_direction: 'row', gap: 40, flex_grow: 1 }}>
        {columns.map((col, ci) => (
          <eink-box key={ci} style={{ flex_direction: 'column', flex_grow: 1, flex_basis: 0, gap: 6 }}>
            {col.map((g) => (
              <eink-box key={g.group} style={{ flex_direction: 'column', margin: [14, 0, 0, 0], gap: 2 }}>
                <Text font_size={22} bold>{g.group.toUpperCase()}</Text>
                {g.pages.map((p) => (
                  <eink-box key={p.id} hit onTap={() => onPick(p.id)} style={{ height: 46, flex_direction: 'row', align_items: 'center', gap: 10 }}>
                    <Text font_size={28} bold={p.id === current} style={{ width: 24 }}>{p.id === current ? '▸' : ''}</Text>
                    <Text font_size={28} bold={p.id === current}>{p.name}</Text>
                  </eink-box>
                ))}
              </eink-box>
            ))}
          </eink-box>
        ))}
      </eink-box>
    </eink-box>
  );
}

export function GalleryApp({ page, onPage }: GalleryAppProps) {
  const [own, setOwn] = useStoredState<string>('gallery:page', PAGES[0]?.id ?? '');
  const [index, setIndex] = useState(false);
  const wanted = page ?? own;
  const at = Math.max(0, PAGES.findIndex((p) => p.id === wanted));
  const current = PAGES[at];

  const goto = useCallback((i: number) => {
    const n = PAGES.length;
    const next = PAGES[((i % n) + n) % n];
    if (!next) return;
    setOwn(next.id);
    onPage?.(next.id);
    setIndex(false);
  }, [onPage, setOwn]);

  if (!current) return <Text>No pages.</Text>;
  return (
    <eink-box bg={255} style={{ width: PANEL_W, height: PANEL_H }}>
      {index
        ? <Index current={current.id} onPick={(id) => goto(PAGES.findIndex((p) => p.id === id))} />
        : <eink-box key={current.id} style={{ width: PANEL_W, height: PANEL_H }}>{current.render()}</eink-box>}
      <Tab label={'‹'} x={CORNER + INDEX_TAB + 6 + TAB + 6} onTap={() => goto(at - 1)} />
      <Tab label={'›'} x={CORNER + INDEX_TAB + 6} onTap={() => goto(at + 1)} />
      <Tab label={index ? 'close' : 'index'} width={INDEX_TAB} x={CORNER} onTap={() => setIndex((v) => !v)} />
    </eink-box>
  );
}

export default GalleryApp;
