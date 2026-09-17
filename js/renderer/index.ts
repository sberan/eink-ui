import Reconciler from 'react-reconciler';
import { DefaultEventPriority, LegacyRoot } from 'react-reconciler/constants.js';
import type { ReactNode } from 'react';
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
    return diffProps(type, oldProps, newProps);
  },

  commitUpdate(inst, updatePayload, _type, _oldProps, newProps) {
    inst.props = newProps;
    if (updatePayload) eink().set_props(inst.id, JSON.stringify(updatePayload));
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
    const damage = eink().commit();
    globalThis.__eink_paint?.(damage);
  },
};

const reconciler = Reconciler(hostConfig);

let container: EinkInstance | null = null;
let root: ReturnType<typeof reconciler.createContainer> | null = null;
let unsubscribe: Unsubscribe | null = null;
// The Kindle and wasm hosts implement `on(cb)` without returning an unsubscribe,
// so a second render() must not register a second listener on the same host.
let subscribedHost: EinkHost | null = null;

/** Mount `element`. Creates the scene root box and wires input on first call. */
export function render(element: ReactNode): EinkInstance {
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
  reconciler.updateContainer(null, root, null, null);
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
export function handleEvent(ev: EinkInputEvent): void {
  if (!ev) return;
  if (ev.type === 'tap') batch(() => dispatchTap(ev));
  else if (ev.type === 'key') batch(() => dispatchKey(ev.key));
  else batch(() => { for (const l of hostListeners) l(ev); });
}

function dispatchTap(ev: { id: NodeId; x: number; y: number }): void {
  let inst = instances.get(ev.id) ?? null;
  // bubble to the nearest ancestor with an onTap
  while (inst) {
    const h = inst.props.onTap;
    if (h) {
      let stopped = false;
      const payload: TapPayload = {
        id: inst.id, x: ev.x, y: ev.y, target: ev.id,
        stopPropagation() { stopped = true; },
      };
      h(payload);
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
