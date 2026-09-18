import { createMockEink, type MockEinkHost, type MockNode } from '../sim/mock-eink.js';
import type { NodeId } from '../host/eink.js';

export type HostCall = readonly [string, ...unknown[]];

/** Lets promise chains (async fetch, fire-and-forget toggles) settle before asserting. */
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export type FetchBody = unknown;
/** An async fetch response the way the Kindle host shapes it. */
export function fetchResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300, status,
    text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body),
  });
}

export interface Harness {
  readonly mock: MockEinkHost;
  readonly host: MockEinkHost;
  readonly calls: HostCall[];
  renderer: typeof import('../renderer/index.js');
  /** Every set_props call as [id, parsed payload]. */
  propCalls(): [NodeId, Record<string, unknown>][];
  textNodes(): string[];
  /** Text of the nodes still attached to the root, unlike textNodes(). Markdown nodes contribute their whole document. */
  liveTexts(): string[];
  /** True when any live text or markdown document contains `s`. */
  hasText(s: string): boolean;
  /** Taps the middle of the task row whose label is `label` (inside a markdown node). */
  tapTask(label: string): void;
  /** Taps the live text node whose text is exactly `text`; the tap bubbles to the nearest onTap. */
  tapText(text: string): void;
  nodes(): MockNode[];
  tree(id?: NodeId, depth?: number): string;
}

const SPIED = [
  'create', 'set_props', 'append', 'insert_before', 'remove', 'commit', 'set_root',
] as const;

/** A mock host that records every call, with the renderer freshly imported against it. */
export async function makeHarness(): Promise<Harness> {
  const mock = createMockEink();
  const calls: HostCall[] = [];
  const host: MockEinkHost = { ...mock };
  for (const k of SPIED) {
    const original = mock[k] as (...a: unknown[]) => unknown;
    (host as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => {
      calls.push([k, ...a]);
      return original(...a);
    };
  }
  globalThis.__eink = host;
  const { vi } = await import('vitest');
  vi.resetModules();
  (await import('../files/index.js')).resetFiles();
  const renderer = await import('../renderer/index.js');

  const nodes = () => [...mock._nodes.values()];

  // the host keeps detached nodes in its map (eink-core does too), so a test
  // that cares about what is on screen must walk the tree from the root
  const liveTexts = (): string[] => {
    const out: string[] = [];
    const walk = (id: NodeId): void => {
      const n = mock._nodes.get(id);
      if (!n) return;
      if (n.kind === 'text' || n.kind === 'markdown') out.push(n.paint.text);
      for (const c of n.children) walk(c);
    };
    walk(mock._root());
    return out;
  };

  const tree = (id: NodeId = mock._root(), depth = 0): string => {
    const n = mock._nodes.get(id);
    if (!n) return '';
    const label = n.kind === 'text' ? `text(${JSON.stringify(n.paint.text)})` : 'box';
    return `${'  '.repeat(depth)}${label}\n`
      + n.children.map((c) => tree(c, depth + 1)).join('');
  };

  return {
    mock, host, calls, renderer, tree, liveTexts,
    hasText: (t: string) => liveTexts().some((x) => x.includes(t)),
    tapText(text: string) {
      const live = new Set<NodeId>();
      const walk = (id: NodeId): void => {
        live.add(id);
        for (const c of mock._nodes.get(id)?.children ?? []) walk(c);
      };
      walk(mock._root());
      for (const n of mock._nodes.values()) {
        if (n.kind !== 'text' || n.paint.text !== text || !live.has(n.id)) continue;
        const x = n.lastRect ? n.lastRect.x + Math.floor(n.lastRect.w / 2) : 0;
        const y = n.lastRect ? n.lastRect.y + Math.floor(n.lastRect.h / 2) : 0;
        mock.emit({ type: 'tap', id: n.id, x, y });
        return;
      }
      throw new Error(`no live text node reading ${JSON.stringify(text)}`);
    },
    tapTask(label: string) {
      for (const n of mock._nodes.values()) {
        if (n.kind !== 'markdown' || !n.lastRect) continue;
        const b = (n.md ?? []).find((b) => b.kind === 'task' && b.text === label);
        if (!b) continue;
        const x = n.lastRect.x + b.rect.x + 40;
        const y = n.lastRect.y + b.rect.y + Math.floor(b.rect.h / 2);
        const line = host.hit_line(x, y);
        mock.emit(line >= 0 ? { type: 'tap', id: host.hit(x, y), x, y, line } : { type: 'tap', id: host.hit(x, y), x, y });
        return;
      }
      throw new Error(`no task row labelled ${JSON.stringify(label)}`);
    },
    propCalls: () => calls
      .filter((c) => c[0] === 'set_props')
      .map((c) => [c[1] as NodeId, JSON.parse(c[2] as string) as Record<string, unknown>]),
    textNodes: () => nodes().filter((n) => n.kind === 'text').map((n) => n.paint.text),
    nodes,
  };
}
