import { createMockEink, type MockEinkHost, type MockNode } from '../sim/mock-eink.js';
import type { NodeId } from '../host/eink.js';

export type HostCall = readonly [string, ...unknown[]];

export interface Harness {
  readonly mock: MockEinkHost;
  readonly host: MockEinkHost;
  readonly calls: HostCall[];
  renderer: typeof import('../renderer/index.js');
  /** Every set_props call as [id, parsed payload]. */
  propCalls(): [NodeId, Record<string, unknown>][];
  textNodes(): string[];
  /** Text of the nodes still attached to the root, unlike textNodes(). */
  liveTexts(): string[];
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
  const renderer = await import('../renderer/index.js');

  const nodes = () => [...mock._nodes.values()];

  // the host keeps detached nodes in its map (eink-core does too), so a test
  // that cares about what is on screen must walk the tree from the root
  const liveTexts = (): string[] => {
    const out: string[] = [];
    const walk = (id: NodeId): void => {
      const n = mock._nodes.get(id);
      if (!n) return;
      if (n.kind === 'text') out.push(n.paint.text);
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
    propCalls: () => calls
      .filter((c) => c[0] === 'set_props')
      .map((c) => [c[1] as NodeId, JSON.parse(c[2] as string) as Record<string, unknown>]),
    textNodes: () => nodes().filter((n) => n.kind === 'text').map((n) => n.paint.text),
    nodes,
  };
}
