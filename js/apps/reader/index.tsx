import React, { useCallback, useState } from 'react';
import { Button, Column, Keyboard, Markdown, Row, StatusBar, Text, toggleTaskLine } from '../../components/index.js';
import { usePageButtons } from '../../device/index.js';
import { readFile, useFile, useFiles, useSync, writeFile } from '../../files/index.js';
import { useStoredState } from '../../storage/index.js';

const PAGE_PAD = 36;

export interface ReaderAppProps {
  /** Repository folder to page through; the newest file opens first. */
  folder?: string;
}

function title(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
}

function appendTask(text: string | null, task: string): string {
  const body = (text ?? '').replace(/\s+$/, '');
  return `${body}\n- [ ] ${task}\n`;
}

interface PageProps { path: string; onToggleTask: (line: number) => void }

// The page subscribes to its own file so a tick re-renders this one node, not the whole app.
function Page({ path, onToggleTask }: PageProps) {
  const text = useFile(path);
  return <Markdown text={text ?? ''} onToggleTask={onToggleTask} />;
}

/** Markdown files from the synced repository: page buttons move between files, taps tick tasks. */
export function ReaderApp({ folder = 'days/' }: ReaderAppProps) {
  const files = useFiles(folder, '.md');
  const [remembered, setRemembered] = useStoredState<string>('reader:path', '');
  const path = files.includes(remembered) ? remembered : (files[files.length - 1] ?? null);
  const sync = useSync();
  const [draft, setDraft] = useState<string | null>(null);

  const at = path ? files.indexOf(path) : -1;
  // a page turn moves focus to another file: the keyboard, if open, goes away
  usePageButtons({
    onLeft: () => { setDraft(null); if (at > 0) setRemembered(files[at - 1]!); },
    onRight: () => { setDraft(null); if (at >= 0 && at < files.length - 1) setRemembered(files[at + 1]!); },
  });

  // handlers read the file when called, so they stay stable across edits of it
  const toggle = useCallback((line: number) => {
    const text = path ? readFile(path) : null;
    if (path && text !== null) {
      // temporary probe: where the handler's milliseconds go on the device
      const t0 = Date.now();
      globalThis.__eink?.buzz();
      const t1 = Date.now();
      const next = toggleTaskLine(text, line);
      const t2 = Date.now();
      writeFile(path, next);
      const t3 = Date.now();
      if (t3 - t0 >= 3) globalThis.__eink?.log(`toggle: buzz ${t1 - t0} ms, edit ${t2 - t1} ms, write+notify ${t3 - t2} ms`);
    }
  }, [path]);

  const onKey = useCallback((key: string) => {
    setDraft((d) => {
      const cur = d ?? '';
      if (key === 'ENTER') {
        const task = cur.trim();
        if (task && path) writeFile(path, appendTask(readFile(path), task));
        return null;
      }
      if (key === 'BACKSPACE') return cur.slice(0, -1);
      return cur + (key === ' ' ? ' ' : key.toLowerCase());
    });
  }, [path]);

  // only states that last go in the status bar: a persistent error, else the file name (HIG rule 3)
  const status = sync.state === 'error' ? 'sync error' : path ? title(path) : folder;

  // The list can be taller than the panel, so the keyboard and the add button are overlays pinned
  // to the bottom edge rather than flow items after the list.
  return (
    <eink-box bg={255} style={{ width: 1072, height: 1448, flex_direction: 'column', padding: [PAGE_PAD, PAGE_PAD, PAGE_PAD, PAGE_PAD] }}>
      <StatusBar title={status} style={{ margin: [0, 0, 8, 0] }} />
      <Column style={{ flex_grow: 1, flex_shrink: 1 }}>
        {path === null
          ? <Text font_size={32}>{`No markdown files under ${folder} yet.`}</Text>
          : <Page path={path} onToggleTask={toggle} />}
      </Column>
      {draft === null ? (
        <eink-box bg={255} style={{ position: 'absolute', right: PAGE_PAD, bottom: PAGE_PAD, padding: 6 }}>
          <Button label="+ task" font_size={28} onTap={() => setDraft('')} style={{ width: 180, height: 56 }} />
        </eink-box>
      ) : (
        <Column bg={255} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: [0, PAGE_PAD, PAGE_PAD, PAGE_PAD], gap: 10 }}>
          <eink-box bg={0} style={{ height: 2 }} />
          <Row style={{ gap: 10, align_items: 'center' }}>
            <eink-box border={2} style={{ padding: 12, height: 60, flex_grow: 1 }}>
              <eink-text text={draft === '' ? 'New task…' : draft} font_size={30} />
            </eink-box>
            <Button label="×" font_size={28} onTap={() => setDraft(null)} style={{ width: 72, height: 60 }} />
          </Row>
          <Keyboard onKey={onKey} />
        </Column>
      )}
    </eink-box>
  );
}

export default ReaderApp;
