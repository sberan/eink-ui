/** Shape of the list the host supplies, plus a hand-written guard for the boundary. */

export interface TodoItem {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
}

export interface TodoSection {
  readonly title: string;
  readonly items: readonly TodoItem[];
}

export interface TodoList {
  readonly date: string;
  readonly sections: readonly TodoSection[];
  /** ISO dates of the neighbouring days, for the page-turn buttons. */
  readonly prev?: string | null;
  readonly next?: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `prev`/`next` may be absent, null, or an ISO date - never anything else. */
function isNeighbour(v: unknown): v is string | null | undefined {
  return v === undefined || v === null || typeof v === 'string';
}

export function isTodoItem(v: unknown): v is TodoItem {
  return isRecord(v)
    && typeof v['id'] === 'string' && v['id'].length > 0
    && typeof v['text'] === 'string'
    && typeof v['done'] === 'boolean';
}

export function isTodoSection(v: unknown): v is TodoSection {
  return isRecord(v)
    && typeof v['title'] === 'string'
    && Array.isArray(v['items'])
    && v['items'].every(isTodoItem);
}

/**
 * Validates a payload from `__eink_data` or `__eink.fetch`. Everything is
 * checked, including item ids, because a duplicate or missing id would make
 * the toggle write to the wrong row.
 */
export function isTodoList(v: unknown): v is TodoList {
  if (!isRecord(v)) return false;
  if (typeof v['date'] !== 'string') return false;
  if (!isNeighbour(v['prev']) || !isNeighbour(v['next'])) return false;
  const sections = v['sections'];
  if (!Array.isArray(sections) || !sections.every(isTodoSection)) return false;
  const ids = new Set<string>();
  for (const s of sections as readonly TodoSection[]) {
    for (const it of s.items) {
      if (ids.has(it.id)) return false;
      ids.add(it.id);
    }
  }
  return true;
}

/** Describes why a payload was rejected, for `__eink.log`. */
export function describeTodoListProblem(v: unknown): string {
  if (!isRecord(v)) return `expected an object, got ${Array.isArray(v) ? 'array' : typeof v}`;
  if (typeof v['date'] !== 'string') return 'missing or non-string "date"';
  if (!isNeighbour(v['prev'])) return '"prev" must be an ISO date or null';
  if (!isNeighbour(v['next'])) return '"next" must be an ISO date or null';
  const sections = v['sections'];
  if (!Array.isArray(sections)) return 'missing or non-array "sections"';
  for (let i = 0; i < sections.length; i++) {
    const s: unknown = sections[i];
    if (!isRecord(s) || typeof s['title'] !== 'string') return `section ${i}: missing "title"`;
    const items = s['items'];
    if (!Array.isArray(items)) return `section ${i}: missing "items"`;
    for (let j = 0; j < items.length; j++) {
      if (!isTodoItem(items[j])) return `section ${i}, item ${j}: expected {id, text, done}`;
    }
  }
  return 'duplicate item id';
}

export function countItems(list: TodoList): number {
  return list.sections.reduce((a, s) => a + s.items.length, 0);
}
