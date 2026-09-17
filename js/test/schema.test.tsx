import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { describeTodoListProblem, isTodoList } from '../apps/todo/schema.js';
import { resolveList } from '../apps/todo/index.js';
import { SAMPLE } from '../apps/todo/sample.js';
import { fetchResponse, makeHarness, tick, type Harness } from './harness.js';

const logged = (spy: ReturnType<typeof vi.fn>): string[] =>
  spy.mock.calls.map((c) => String(c[0]));

const GOOD = {
  date: '2026-09-15',
  sections: [{ title: 'A', items: [{ id: '1', text: 'x', done: false }] }],
};

describe('isTodoList', () => {
  it('accepts a well formed payload', () => {
    expect(isTodoList(GOOD)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['an array', []],
    ['a string', 'nope'],
    ['a missing date', { sections: [] }],
    ['a numeric date', { date: 20260915, sections: [] }],
    ['missing sections', { date: '2026-09-15' }],
    ['a section without a title', { date: '2026-09-15', sections: [{ items: [] }] }],
    ['a section without items', { date: '2026-09-15', sections: [{ title: 'A' }] }],
    ['an item with no id', { date: '2026-09-15', sections: [{ title: 'A', items: [{ text: 'x', done: false }] }] }],
    ['an item with an empty id', { date: '2026-09-15', sections: [{ title: 'A', items: [{ id: '', text: 'x', done: false }] }] }],
    ['a non-boolean done', { date: '2026-09-15', sections: [{ title: 'A', items: [{ id: '1', text: 'x', done: 'yes' }] }] }],
    ['a numeric prev', { date: '2026-09-15', sections: [], prev: 7 }],
    ['an object next', { date: '2026-09-15', sections: [], next: {} }],
    ['duplicate item ids', {
      date: '2026-09-15',
      sections: [
        { title: 'A', items: [{ id: '1', text: 'x', done: false }] },
        { title: 'B', items: [{ id: '1', text: 'y', done: false }] },
      ],
    }],
  ])('rejects %s', (_name, value) => {
    expect(isTodoList(value)).toBe(false);
    expect(describeTodoListProblem(value)).not.toBe('');
  });
});

describe('resolveList', () => {
  afterEach(() => { globalThis.__eink_data = undefined; });

  it('prefers the prop', () => {
    expect(resolveList(GOOD)).toBe(GOOD);
  });

  it('accepts a valid __eink_data', () => {
    globalThis.__eink_data = GOOD;
    expect(resolveList()).toEqual(GOOD);
  });

  it('falls back to the sample on a malformed __eink_data', () => {
    globalThis.__eink_data = { date: 1, sections: 'nope' };
    expect(resolveList()).toBe(SAMPLE);
  });
});

describe('prev / next links', () => {
  it('accepts absent, null and ISO neighbours', () => {
    expect(isTodoList({ ...GOOD })).toBe(true);
    expect(isTodoList({ ...GOOD, prev: null, next: null })).toBe(true);
    expect(isTodoList({ ...GOOD, prev: '2026-09-14', next: '2026-09-16' })).toBe(true);
  });
});

describe('entry-kindle boundary', () => {
  let h: Harness;

  beforeEach(async () => { h = await makeHarness(); });
  afterEach(() => {
    h.renderer.unmount();
    globalThis.__eink = undefined;
    globalThis.__eink_data = undefined;
    globalThis.__eink_app = undefined;
  });

  it('renders the injected list when it is valid', async () => {
    globalThis.__eink_data = GOOD;
    await import('../entry-kindle.js');
    expect(h.textNodes()).toContain('x');
    expect(h.textNodes()).toContain('0/1 done');
  });

  it('logs and renders the sample when the payload is malformed', async () => {
    const logSpy = vi.fn();
    h.host.log = logSpy;
    globalThis.__eink_data = { date: '2026-09-15', sections: [{ title: 'A', items: [{ id: 1 }] }] };
    await import('../entry-kindle.js');
    expect(logged(logSpy).some((l) => l.includes('__eink_data rejected'))).toBe(true);
    expect(logged(logSpy).some((l) => l.startsWith('list loaded: date=2026-09-15 items=21'))).toBe(true);
    expect(h.textNodes()).toContain('5/21 done');
  });

  it('logs and renders the sample when fetch returns a bad payload', async () => {
    const logSpy = vi.fn();
    h.host.log = logSpy;
    h.host.fetch = () => fetchResponse(200, []);
    await import('../entry-kindle.js');
    await tick();
    expect(logged(logSpy).some((l) => l.includes('failed'))).toBe(true);
    expect(h.textNodes()).toContain('5/21 done');
  });

  it('logs and renders the sample when fetch throws', async () => {
    const logSpy = vi.fn();
    h.host.log = logSpy;
    h.host.fetch = () => { throw new Error('no network'); };
    await import('../entry-kindle.js');
    await tick();
    expect(logged(logSpy).some((l) => l.includes('no network'))).toBe(true);
    expect(h.textNodes()).toContain('5/21 done');
  });

  it('logs the loaded list with its date, item count and neighbours', async () => {
    const logSpy = vi.fn();
    h.host.log = logSpy;
    globalThis.__eink_data = { ...GOOD, prev: '2026-09-14', next: '2026-09-16' };
    await import('../entry-kindle.js');
    expect(logged(logSpy)).toContain(
      'list loaded: date=2026-09-15 items=1 prev=2026-09-14 next=2026-09-16',
    );
  });
});

describe('page-turn day switching', () => {
  let h: Harness;
  const TUE = {
    date: '2026-09-15',
    prev: '2026-09-14',
    next: '2026-09-16',
    sections: [{ title: 'Tue', items: [{ id: 't1', text: 'tuesday task', done: false }] }],
  };
  const WED = {
    date: '2026-09-16',
    prev: '2026-09-15',
    next: null,
    sections: [{ title: 'Wed', items: [{ id: 'w1', text: 'wednesday task', done: false }] }],
  };
  const DAYS: Record<string, unknown> = { '2026-09-15': TUE, '2026-09-16': WED };

  let logSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    h = await makeHarness();
    logSpy = vi.fn();
    h.host.log = logSpy;
    h.host.fetch = (url: string) => {
      const date = /date=([^&]+)/.exec(url)?.[1] ?? '';
      const body = DAYS[decodeURIComponent(date)];
      return body === undefined ? fetchResponse(404, null) : fetchResponse(200, body);
    };
    globalThis.__eink_data = TUE;
    await import('../entry-kindle.js');
    await tick();
  });

  afterEach(() => {
    h.renderer.unmount();
    globalThis.__eink = undefined;
    globalThis.__eink_data = undefined;
  });

  it('goes forward to the next day and back again', async () => {
    expect(h.liveTexts()).toContain('tuesday task');

    h.mock.emit({ type: 'key', key: 'PageNext' });
    await tick();
    expect(h.liveTexts()).toContain('wednesday task');
    expect(h.liveTexts()).not.toContain('tuesday task');

    // the regression: going back used to leave Wednesday on screen
    h.mock.emit({ type: 'key', key: 'PagePrev' });
    await tick();
    expect(h.liveTexts()).toContain('tuesday task');
    expect(h.liveTexts()).not.toContain('wednesday task');
  });

  it('logs the key, the target and the newly loaded list', async () => {
    h.mock.emit({ type: 'key', key: 'PageNext' });
    await tick();
    const lines = logged(logSpy);
    expect(lines).toContain('key received: PageNext');
    expect(lines).toContain('day switch target: 2026-09-16');
    expect(lines).toContain('list loaded: date=2026-09-16 items=1 prev=2026-09-15 next=none');
  });

  it('logs an unmapped key and changes nothing', () => {
    h.mock.emit({ type: 'key', key: 'Q' });
    expect(logged(logSpy)).toContain('key received: Q');
    expect(h.liveTexts()).toContain('tuesday task');
  });

  it('logs when there is no further day in that direction', async () => {
    h.mock.emit({ type: 'key', key: 'PageNext' });
    await tick();
    h.mock.emit({ type: 'key', key: 'PageNext' });
    await tick();
    expect(logged(logSpy).some((l) => l.startsWith('no next day from 2026-09-16'))).toBe(true);
    expect(h.liveTexts()).toContain('wednesday task');
  });

  it('logs a failed loadDay and leaves the screen alone', async () => {
    h.host.fetch = () => fetchResponse(503, null);
    h.mock.emit({ type: 'key', key: 'PageNext' });
    await tick();
    expect(logged(logSpy)).toContain('loadDay 2026-09-16 failed: HTTP 503');
    expect(h.liveTexts()).toContain('tuesday task');
  });

  it('logs a loadDay that throws', async () => {
    h.host.fetch = () => { throw new Error('radio off'); };
    h.mock.emit({ type: 'key', key: 'PageNext' });
    await tick();
    expect(logged(logSpy).some((l) => l.includes('loadDay 2026-09-16 failed') && l.includes('radio off'))).toBe(true);
    expect(h.liveTexts()).toContain('tuesday task');
  });

  it('logs a loadDay whose payload is malformed', async () => {
    h.host.fetch = () => fetchResponse(200, { date: 1 });
    h.mock.emit({ type: 'key', key: 'PageNext' });
    await tick();
    expect(logged(logSpy).some((l) => l.startsWith('loadDay 2026-09-16 failed:'))).toBe(true);
    expect(h.liveTexts()).toContain('tuesday task');
  });
});
