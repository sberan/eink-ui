import React, { memo, useCallback, useMemo, useState } from 'react';
import { Keyboard, KEYBOARD_HEIGHT } from '../../components/index.js';
import { useKeys } from '../../renderer/useKeys.js';
import { SIZE, cellAt, clueFor, isBlack, numberGrid, type Direction } from './puzzle.js';

const CELL = 96;
const PAD = 60;
const SELECTED_BG = 0;

interface CellProps {
  r: number;
  c: number;
  black: boolean;
  number: number;
  letter: string;
  selected: boolean;
  onSelect: (r: number, c: number) => void;
}

/**
 * One square. Memoised on (letter, selected) so a cursor move repaints exactly
 * two cells; the clue line is the only other node that changes.
 */
const Cell = memo(function Cell({ r, c, black, number, letter, selected, onSelect }: CellProps) {
  const tap = useCallback(() => onSelect(r, c), [onSelect, r, c]);
  if (black) {
    return <eink-box bg={0} style={{ width: CELL, height: CELL }} />;
  }
  // the clue number is an overlay in the corner, so the letter's box is the whole square in
  // every cell and the letters of a row share one baseline; the selected square is inverted
  const ink = selected ? 255 : 0;
  return (
    <eink-box
      hit
      onTap={tap}
      bg={selected ? SELECTED_BG : 255}
      border={2}
      border_color={0}
      style={{ width: CELL, height: CELL, align_items: 'center', justify_content: 'center' }}
    >
      {number > 0 && (
        <eink-text
          text={String(number)}
          font_size={18}
          color={ink}
          style={{ position: 'absolute', top: 2, left: 5, height: 22 }}
        />
      )}
      <eink-text
        text={letter}
        font_size={52}
        bold
        align="center"
        color={ink}
        style={{ width: CELL - 4, height: CELL - 4 }}
      />
    </eink-box>
  );
});

type Letters = readonly (readonly string[])[];

function emptyLetters(): Letters {
  return Array.from({ length: SIZE }, () => new Array<string>(SIZE).fill(''));
}

function letterAt(letters: Letters, r: number, c: number): string {
  return cellAt(letters, r, c, '');
}

function writeCell(letters: Letters, r: number, c: number, ch: string): Letters {
  if (letterAt(letters, r, c) === ch) return letters;
  return letters.map((row, i) => (i === r ? row.map((v, j) => (j === c ? ch : v)) : row));
}

/** Step one cell along `dir`, staying inside the current entry. */
function nextCell(r: number, c: number, dir: Direction, step: number): readonly [number, number] | null {
  const nr = dir === 'down' ? r + step : r;
  const nc = dir === 'across' ? c + step : c;
  if (nr < 0 || nc < 0 || nr >= SIZE || nc >= SIZE) return null;
  return isBlack(nr, nc) ? null : [nr, nc];
}

interface Cursor {
  readonly letters: Letters;
  readonly r: number;
  readonly c: number;
  readonly dir: Direction;
}

export function CrosswordApp() {
  const numbers = useMemo(() => numberGrid(), []);
  // one state object: a keystroke moves the cursor and writes a letter atomically
  const [st, setSt] = useState<Cursor>(() => ({ letters: emptyLetters(), r: 0, c: 0, dir: 'across' }));

  const onSelect = useCallback((r: number, c: number) => {
    setSt((p) => (p.r === r && p.c === c
      ? { ...p, dir: p.dir === 'across' ? 'down' : 'across' }
      : { ...p, r, c }));
  }, []);

  const onKey = useCallback((key: string) => {
    setSt((p) => {
      if (key === 'ENTER' || key === 'Enter' || key === ' ') {
        return { ...p, dir: p.dir === 'across' ? 'down' : 'across' };
      }
      if (key === 'BACKSPACE' || key === 'Backspace') {
        if (letterAt(p.letters, p.r, p.c)) {
          return { ...p, letters: writeCell(p.letters, p.r, p.c, '') };
        }
        const back = nextCell(p.r, p.c, p.dir, -1);
        if (!back) return p;
        return { ...p, r: back[0], c: back[1], letters: writeCell(p.letters, back[0], back[1], '') };
      }
      if (!/^[A-Za-z]$/.test(key)) return p;
      const letters = writeCell(p.letters, p.r, p.c, key.toUpperCase());
      const fwd = nextCell(p.r, p.c, p.dir, 1);
      return fwd ? { ...p, letters, r: fwd[0], c: fwd[1] } : { ...p, letters };
    });
  }, []);

  useKeys(onKey);

  const clue = clueFor(st.r, st.c, st.dir);
  const number = cellAt(numbers, clue.start[0], clue.start[1], 0);
  const clueText = `${number}${st.dir === 'across' ? 'A' : 'D'}  ${clue.text}`;

  const rows: React.ReactNode[] = [];
  for (let r = 0; r < SIZE; r++) {
    const cells: React.ReactNode[] = [];
    for (let c = 0; c < SIZE; c++) {
      cells.push(
        <Cell
          key={c}
          r={r}
          c={c}
          black={isBlack(r, c)}
          number={cellAt(numbers, r, c, 0)}
          letter={letterAt(st.letters, r, c)}
          selected={st.r === r && st.c === c}
          onSelect={onSelect}
        />,
      );
    }
    rows.push(
      <eink-box key={r} style={{ flex_direction: 'row', height: CELL }}>{cells}</eink-box>,
    );
  }

  return (
    <eink-box bg={255} style={{ width: 1072, height: 1448, flex_direction: 'column' }}>
      <eink-text
        text="Mini Crossword"
        font_size={38}
        bold
        align="center"
        style={{ height: 62, margin: [16, 0, 0, 0], width: 1072 }}
      />
      <eink-box style={{ flex_direction: 'column', margin: [0, 0, 0, PAD] }}>{rows}</eink-box>
      <eink-box style={{ flex_grow: 1 }} />
      <eink-box bg={255} border={2} style={{ height: 76, justify_content: 'center', padding: [0, PAD, 0, PAD] }}>
        <eink-text text={clueText} font_size={32} color={0} />
      </eink-box>
      <Keyboard onKey={onKey} style={{ height: KEYBOARD_HEIGHT }} />
    </eink-box>
  );
}

export default CrosswordApp;
