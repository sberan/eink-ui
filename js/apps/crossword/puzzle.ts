// 9x9 mini. Four 4x4 all-checked blocks separated by a black cross.
// '#' is a black square. Every entry is a common four-letter word.

export const SIZE = 9;

export type Direction = 'across' | 'down';

export const GRID: readonly string[] = [
  'chat#dawn',
  'hire#oboe',
  'even#slow',
  'feat#eels',
  '#########',
  'deck#fist',
  'icon#odor',
  'shoe#were',
  'hole#late',
];

/** Black-square mask derived from the solution, so the two cannot drift apart. */
export const BLACK: readonly (readonly boolean[])[] =
  GRID.map((row) => row.split('').map((ch) => ch === '#'));

/** Reads a grid cell with bounds checking; out of range counts as black. */
export function cellAt<T>(grid: readonly (readonly T[])[], r: number, c: number, fallback: T): T {
  return grid[r]?.[c] ?? fallback;
}

export function isBlack(r: number, c: number, black: readonly (readonly boolean[])[] = BLACK): boolean {
  return cellAt(black, r, c, true);
}

export const CLUES: Readonly<Record<string, string>> = {
  '0,0,across': 'Informal talk',
  '0,5,across': 'First light',
  '1,0,across': 'Take on staff',
  '1,5,across': 'Double-reed woodwind',
  '2,0,across': 'Level, or divisible by two',
  '2,5,across': 'Not quick',
  '3,0,across': 'Notable achievement',
  '3,5,across': 'Long, snakelike fish',
  '5,0,across': "Ship's floor",
  '5,5,across': 'Closed hand',
  '6,0,across': 'Small screen symbol',
  '6,5,across': 'Smell',
  '7,0,across': 'Foot cover',
  '7,5,across': 'Past plural of "be"',
  '8,0,across': 'Gap',
  '8,5,across': 'After the hour',

  '0,0,down': 'Kitchen boss',
  '0,1,down': 'Bee home',
  '0,2,down': 'Region',
  '0,3,down': 'Camp shelter',
  '0,5,down': 'Measured amount of medicine',
  '0,6,down': 'Capable',
  '0,7,down': "Sheep's wool",
  '0,8,down': 'Daily reports',
  '5,0,down': 'Plate, or a menu item',
  '5,1,down': 'Repeated sound',
  '5,2,down': 'Mildly cold',
  '5,3,down': 'Leg joint',
  '5,5,down': 'Barnyard bird',
  '5,6,down': 'Thought',
  '5,7,down': 'Arrange by kind',
  '5,8,down': 'Oak or elm',
};

/** True when (r, c) is the first cell of an entry running in `dir`. */
export function startsEntry(
  r: number, c: number, dir: Direction,
  black: readonly (readonly boolean[])[] = BLACK, size = SIZE,
): boolean {
  if (isBlack(r, c, black)) return false;
  if (dir === 'across') {
    return (c === 0 || isBlack(r, c - 1, black)) && c + 1 < size && !isBlack(r, c + 1, black);
  }
  return (r === 0 || isBlack(r - 1, c, black)) && r + 1 < size && !isBlack(r + 1, c, black);
}

/** Standard crossword numbering, in reading order. */
export function numberGrid(
  black: readonly (readonly boolean[])[] = BLACK, size = SIZE,
): number[][] {
  const numbers: number[][] = [];
  let n = 0;
  for (let r = 0; r < size; r++) {
    const row = new Array<number>(size).fill(0);
    numbers.push(row);
    for (let c = 0; c < size; c++) {
      if (isBlack(r, c, black)) continue;
      if (startsEntry(r, c, 'across', black, size) || startsEntry(r, c, 'down', black, size)) {
        row[c] = ++n;
      }
    }
  }
  return numbers;
}

/** First cell of the entry containing (r, c) in `dir`. */
export function entryStart(
  r: number, c: number, dir: Direction,
  black: readonly (readonly boolean[])[] = BLACK,
): readonly [number, number] {
  let row = r;
  let col = c;
  if (dir === 'across') {
    while (col > 0 && !isBlack(row, col - 1, black)) col--;
  } else {
    while (row > 0 && !isBlack(row - 1, col, black)) row--;
  }
  return [row, col];
}

export interface Clue {
  readonly start: readonly [number, number];
  readonly text: string;
}

export function clueFor(
  r: number, c: number, dir: Direction,
  black: readonly (readonly boolean[])[] = BLACK,
  clues: Readonly<Record<string, string>> = CLUES,
): Clue {
  const start = entryStart(r, c, dir, black);
  return { start, text: clues[`${start[0]},${start[1]},${dir}`] ?? '' };
}
