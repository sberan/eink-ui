import Reconciler from 'react-reconciler';
import { DefaultEventPriority, LegacyRoot } from 'react-reconciler/constants.js';
import { Fragment, createElement, useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type {
  EinkHost, EinkInputEvent, EinkProps, NodeId, Unsubscribe,
} from '../host/eink.js';
import type { TapPayload } from '../global.js';
import {
  KIND, diffProps, initialPayload, isTextChild,
  type IntrinsicProps, type IntrinsicType,
} from './host.js';

export interface EinkInstance {
  readonly id: NodeId;
  readonly type: IntrinsicType;
  props: IntrinsicProps;
  parent: EinkInstance | null;
  children: EinkInstance[];
}

type TimeoutHandle = ReturnType<typeof setTimeout>;
const NO_TIMEOUT = -1;

function eink(): EinkHost {
  const e = globalThis.__eink;
  if (!e) throw new Error('globalThis.__eink is not installed');
  return e;
}

/** id -> instance, for hit-test -> React props lookup. */
export const instances = new Map<NodeId, EinkInstance>();

interface KeyRegistration { fn: (key: string) => void }

/** onKey registrations; the last entry (most recently mounted) wins. */
const keyHandlers: KeyRegistration[] = [];

function makeInstance(type: IntrinsicType, props: IntrinsicProps): EinkInstance {
  const id = eink().create(KIND[type]);
  const inst: EinkInstance = { id, type, props, parent: null, children: [] };
  instances.set(id, inst);
  const payload = initialPayload(type, props);
  if (Object.keys(payload).length) eink().set_props(id, JSON.stringify(payload));
  return inst;
}

function reorder(parent: EinkInstance, child: EinkInstance, before: EinkInstance): void {
  const cur = parent.children.indexOf(child);
  if (cur !== -1) parent.children.splice(cur, 1);
  const at = parent.children.indexOf(before);
  parent.children.splice(at === -1 ? parent.children.length : at, 0, child);
}

function detach(parent: EinkInstance, child: EinkInstance): void {
  const i = parent.children.indexOf(child);
  if (i !== -1) parent.children.splice(i, 1);
  child.parent = null;
}

// React's own detachDeletedInstance only runs with the passive effects, so the
// id -> instance map is pruned here, in the mutation phase, instead.
function forget(inst: EinkInstance): void {
  instances.delete(inst.id);
  for (const c of inst.children) forget(c);
}

type Config = Reconciler.HostConfig<
  IntrinsicType, IntrinsicProps, EinkInstance, EinkInstance, EinkInstance,
  EinkInstance, EinkInstance, EinkInstance, null, EinkProps, never,
  TimeoutHandle, typeof NO_TIMEOUT
>;

const hostConfig: Config = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  noTimeout: NO_TIMEOUT,
  // the Kindle's QuickJS only has setTimeout/clearTimeout
  scheduleTimeout: (fn, delay) => setTimeout(fn, delay),
  cancelTimeout: (h) => { clearTimeout(h); },

  getRootHostContext: () => null,
  getChildHostContext: (parentContext) => parentContext,
  getPublicInstance: (inst) => inst,
  prepareForCommit: () => null,
  preparePortalMount: () => {},
  getCurrentEventPriority: () => DefaultEventPriority,
  getInstanceFromNode: () => null,
  getInstanceFromScope: () => null,
  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  prepareScopeUpdate: () => {},
  detachDeletedInstance: (inst) => { instances.delete(inst.id); },

  createInstance(type, props) {
    if (!(type in KIND)) throw new Error(`unknown intrinsic <${type}>`);
    return makeInstance(type, props);
  },

  createTextInstance(text) {
    // a bare string outside <eink-text>: wrap it in a text node
    return makeInstance('eink-text', { text });
  },

  // <eink-text>hello</eink-text>: the string is the `text` prop, not a child node
  shouldSetTextContent(type, props) {
    return type === 'eink-text' && (isTextChild(props.children) || props.text !== undefined);
  },

  appendInitialChild(parent, child) {
    eink().append(parent.id, child.id);
    parent.children.push(child);
    child.parent = parent;
  },

  finalizeInitialChildren: () => false,

  prepareUpdate(_inst, type, oldProps, newProps) {
    const diff = diffProps(type, oldProps, newProps);
    // A changed handler paints nothing, but the instance must still learn about it: otherwise a
    // row whose look did not change keeps calling a closure over stale state.
    if (diff === null && oldProps.onTap !== newProps.onTap) return {};
    return diff;
  },

  commitUpdate(inst, updatePayload, _type, _oldProps, newProps) {
    inst.props = newProps;
    if (updatePayload && Object.keys(updatePayload).length > 0) {
      eink().set_props(inst.id, JSON.stringify(updatePayload));
    }
  },

  commitTextUpdate(inst, _old, newText) {
    inst.props = { text: newText };
    eink().set_props(inst.id, JSON.stringify({ text: newText }));
  },

  commitMount: () => {},
  resetTextContent: () => {},

  appendChild(parent, child) {
    eink().append(parent.id, child.id);
    parent.children.push(child);
    child.parent = parent;
  },

  appendChildToContainer(container, child) {
    eink().append(container.id, child.id);
    container.children.push(child);
    child.parent = container;
  },

  insertBefore(parent, child, before) {
    eink().insert_before(parent.id, child.id, before.id);
    reorder(parent, child, before);
    child.parent = parent;
  },

  insertInContainerBefore(container, child, before) {
    eink().insert_before(container.id, child.id, before.id);
    reorder(container, child, before);
    child.parent = container;
  },

  removeChild(parent, child) {
    eink().remove(parent.id, child.id);
    detach(parent, child);
    forget(child);
  },

  removeChildFromContainer(container, child) {
    eink().remove(container.id, child.id);
    detach(container, child);
    forget(child);
  },

  clearContainer(container) {
    for (const c of container.children.slice()) {
      eink().remove(container.id, c.id);
      c.parent = null;
      forget(c);
    }
    container.children.length = 0;
  },

  hideInstance: (inst) => eink().set_props(inst.id, JSON.stringify({ style: { display: 'none' } })),
  unhideInstance: (inst) => eink().set_props(inst.id, JSON.stringify({ style: { display: 'flex' } })),
  hideTextInstance: (inst) => eink().set_props(inst.id, JSON.stringify({ style: { display: 'none' } })),
  unhideTextInstance: (inst) => eink().set_props(inst.id, JSON.stringify({ style: { display: 'flex' } })),

  resetAfterCommit() {
    // The panel cannot show two updates closer than one partial refresh, so commits that no one
    // is waiting for (timers, sync and file events, late data) share one paint per frame window,
    // while a tap or a key paints at once. See docs/HIG.md.
    if (!painted || Date.now() - lastInputAt < INPUT_WINDOW_MS) {
      cancelFrame();
      flush();
      return;
    }
    if (frameTimer === null) frameTimer = setTimeout(flush, frameMs);
  },
};

/** Window for coalescing non-input paints, about one DU refresh. */
export let frameMs = 250;
export function setFrameMs(ms: number): void { frameMs = ms; }

/** React delivers an input's update after the event batch, so "input-driven" means recent input. */
const INPUT_WINDOW_MS = 300;
let lastInputAt = 0;
let painted = false;
let frameTimer: ReturnType<typeof setTimeout> | null = null;

function cancelFrame(): void {
  if (frameTimer !== null) { clearTimeout(frameTimer); frameTimer = null; }
}

function flush(): void {
  frameTimer = null;
  painted = true;
  const t0 = Date.now();
  const damage = eink().commit();
  phase.commit += Date.now() - t0;
  phase.commits += 1;
  globalThis.__eink_paint?.(damage);
}

const reconciler = Reconciler(hostConfig);

let container: EinkInstance | null = null;
let root: ReturnType<typeof reconciler.createContainer> | null = null;
let unsubscribe: Unsubscribe | null = null;
// The Kindle and wasm hosts implement `on(cb)` without returning an unsubscribe,
// so a second render() must not register a second listener on the same host.
let subscribedHost: EinkHost | null = null;

let capturing: ((element: ReactNode) => void) | null = null;

/**
 * For the simulator: loads an app module and hands back what it passed to `render()` as a
 * component, so the app becomes a page of the simulator instead of taking the panel. The
 * import is dynamic so the module runs after the capture is armed.
 */
export function captureApp(load: () => Promise<unknown>): () => ReactElement {
  let captured: ReactNode = null;
  const listeners = new Set<() => void>();
  capturing = (element) => {
    captured = element;
    for (const l of listeners) l();
  };
  const loading = load().catch((e: unknown) => { throw e; });
  return function CapturedApp(): ReactElement {
    const [element, setElement] = useState<ReactNode>(captured);
    useEffect(() => {
      const l = () => setElement(captured);
      listeners.add(l);
      void loading.then(l);
      return () => { listeners.delete(l); };
    }, []);
    return createElement(Fragment, null, element);
  };
}

/** Mount `element`. Creates the scene root box and wires input on first call. */
export function render(element: ReactNode): EinkInstance {
  if (capturing) {
    capturing(element);
    return container ?? { id: -1, type: 'eink-box', props: {}, parent: null, children: [] };
  }
  let c = container;
  if (!root || !c) {
    const host = eink();
    const rootId = host.create('box');
    c = { id: rootId, type: 'eink-box', props: {}, parent: null, children: [] };
    container = c;
    instances.set(rootId, c);
    host.set_props(rootId, JSON.stringify({
      style: { width: host.width, height: host.height, flex_direction: 'column' },
      bg: 255,
    }));
    host.set_root(rootId);
    root = reconciler.createContainer(
      c, LegacyRoot, null, false, null, '', (e: Error) => { throw e; }, null,
    );
    if (subscribedHost !== host) {
      unsubscribe = host.on(handleEvent) ?? null;
      subscribedHost = host;
    }
  }
  reconciler.updateContainer(element, root, null, null);
  return c;
}

export function unmount(): void {
  if (!root) return;
  cancelFrame();
  reconciler.updateContainer(null, root, null, null);
  painted = false;
  if (unsubscribe) {
    unsubscribe();
    subscribedHost = null;
  }
  unsubscribe = null;
  root = null;
  container = null;
  instances.clear();
  keyHandlers.length = 0;
}

export function batch(fn: () => void): void {
  reconciler.batchedUpdates(fn, undefined);
}

type HostEventListener = (ev: EinkInputEvent) => void;
const hostListeners = new Set<HostEventListener>();

/** Non-input host events (`files`, `sync`) go to every subscriber, e.g. the files module. */
export function subscribeHostEvents(fn: HostEventListener): Unsubscribe {
  hostListeners.add(fn);
  return () => { hostListeners.delete(fn); };
}

/** Dispatch a host event. Exported for tests and for the simulator. */
/** Phase timings of the last input event, for the host's slow-event log. */
const phase = { handler: 0, commit: 0, commits: 0, fn: 0 };

export function handleEvent(ev: EinkInputEvent): void {
  if (!ev) return;
  if (ev.type === 'tap' || ev.type === 'key') {
    lastInputAt = Date.now();
    phase.handler = 0; phase.commit = 0; phase.commits = 0; phase.fn = 0;
    const t0 = Date.now();
    if (ev.type === 'tap') batch(() => dispatchTap(ev));
    else batch(() => dispatchKey(ev.key));
    phase.handler = Date.now() - t0;
    if (phase.handler >= 20) globalThis.__eink?.log(`react: batch ${phase.handler} ms = app handler ${phase.fn} ms + react render/commit ${phase.handler - phase.fn - phase.commit} ms + host commit ${phase.commit} ms`);
  } else {
    // the sleep notice must be on the panel before the host suspends: paint it like input
    if (ev.type === 'power') lastInputAt = Date.now();
    batch(() => { for (const l of hostListeners) l(ev); });
  }
}

function dispatchTap(ev: { id: NodeId; x: number; y: number; line?: number }): void {
  let inst = instances.get(ev.id) ?? null;
  // bubble to the nearest ancestor with an onTap
  while (inst) {
    const h = inst.props.onTap;
    if (h) {
      let stopped = false;
      const payload: TapPayload = {
        id: inst.id, x: ev.x, y: ev.y, target: ev.id,
        ...(ev.line !== undefined ? { line: ev.line } : {}),
        stopPropagation() { stopped = true; },
      };
      const t = Date.now();
      h(payload);
      phase.fn += Date.now() - t;
      if (stopped) return;
    }
    inst = inst.parent;
  }
}

function dispatchKey(key: string): void {
  // focus model: the most recently mounted useKeys() owner wins
  const reg = keyHandlers[keyHandlers.length - 1];
  if (reg) reg.fn(key);
}

export function registerKeys(fn: (key: string) => void): Unsubscribe {
  const reg: KeyRegistration = { fn };
  keyHandlers.push(reg);
  return () => {
    const i = keyHandlers.indexOf(reg);
    if (i !== -1) keyHandlers.splice(i, 1);
  };
}

export { keyHandlers, reconciler };
