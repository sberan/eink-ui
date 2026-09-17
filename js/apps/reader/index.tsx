import React, { useCallback, useState } from 'react';
import { Button, Column, Keyboard, Markdown, Row, StatusBar, Text, toggleTaskLine } from '../../components/index.js';
import { usePageButtons } from '../../device/index.js';
import { useFile, useFiles, useSync, writeFile } from '../../files/index.js';
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

/** Markdown files from the synced repository: page buttons move between files, taps tick tasks. */
export function ReaderApp({ folder = 'days/' }: ReaderAppProps) {
  const files = useFiles(folder, '.md');
  const [remembered, setRemembered] = useStoredState<string>('reader:path', '');
  const path = files.includes(remembered) ? remembered : (files[files.length - 1] ?? null);
  const text = useFile(path ?? '');
  const sync = useSync();
  const [draft, setDraft] = useState<string | null>(null);

  const at = path ? files.indexOf(path) : -1;
  // a page turn moves focus to another file: the keyboard, if open, goes away
  usePageButtons({
    onLeft: () => { setDraft(null); if (at > 0) setRemembered(files[at - 1]!); },
    onRight: () => { setDraft(null); if (at >= 0 && at < files.length - 1) setRemembered(files[at + 1]!); },
  });

  const toggle = useCallback((line: number) => {
    if (path && text !== null) {
      globalThis.__eink?.buzz();
      writeFile(path, toggleTaskLine(text, line));
    }
  }, [path, text]);

  const onKey = useCallback((key: string) => {
    setDraft((d) => {
      const cur = d ?? '';
      if (key === 'ENTER') {
        const task = cur.trim();
        if (task && path) writeFile(path, appendTask(text, task));
        return null;
      }
      if (key === 'BACKSPACE') return cur.slice(0, -1);
      return cur + (key === ' ' ? ' ' : key.toLowerCase());
    });
  }, [path, text]);

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
          : <Markdown text={text ?? ''} onToggleTask={toggle} />}
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
