// QuickJS entry point. The host installs globalThis.__eink, setTimeout and
// clearTimeout before evaluating this bundle, and may install __eink_data
// (the todo list) and __eink_app ("todo" | "crossword").
import React from 'react';
import { registerKeys, render } from './renderer/index.js';
import { TodoApp } from './apps/todo/index.js';
import { CrosswordApp } from './apps/crossword/index.js';
import { SAMPLE } from './apps/todo/sample.js';
import {
  countItems, describeTodoListProblem, isTodoList, type TodoList,
} from './apps/todo/schema.js';

const LIST_ENDPOINT = '/api/items';

/** Page-turn buttons; the raw key is logged so an unmapped one is easy to spot. */
const PREV_KEYS = new Set(['PagePrev', 'PageUp', 'PREV', 'ArrowLeft', 'ArrowUp']);
const NEXT_KEYS = new Set(['PageNext', 'PageDown', 'NEXT', 'ArrowRight', 'ArrowDown']);

export function log(msg: string): void {
  globalThis.__eink?.log(msg);
}

let current: TodoList | null = null;

/**
 * Renders one day. The `key` forces a fresh TodoApp per date: without it the
 * old instance kept its seeded `useState(sections)` and the page-turn buttons
 * looked one-way. TodoApp resets on a changed date too, so both halves hold.
 */
export function showTodo(data: TodoList): void {
  current = data;
  log(`list loaded: date=${data.date} items=${countItems(data)} `
    + `prev=${data.prev ?? 'none'} next=${data.next ?? 'none'}`);
  render(React.createElement(TodoApp, { key: data.date, data, endpoint: LIST_ENDPOINT }));
}

/** Fetches one day and shows it. Every failure path logs and leaves the screen alone. */
export function loadDay(date: string): void {
  log(`day switch target: ${date}`);
  const host = globalThis.__eink;
  if (!host?.fetch) {
    log(`loadDay ${date} failed: host has no fetch`);
    return;
  }
  try {
    const res = host.fetch(`${LIST_ENDPOINT}?date=${encodeURIComponent(date)}`);
    if (!res.ok) {
      log(`loadDay ${date} failed: HTTP ${res.status}`);
      return;
    }
    const body: unknown = res.json();
    if (!isTodoList(body)) {
      log(`loadDay ${date} failed: ${describeTodoListProblem(body)}`);
      return;
    }
    showTodo(body);
  } catch (err) {
    log(`loadDay ${date} failed: ${String(err)}`);
  }
}

export function onKey(key: string): void {
  log(`key received: ${key}`);
  const target = PREV_KEYS.has(key) ? current?.prev
    : NEXT_KEYS.has(key) ? current?.next
      : undefined;
  if (target === undefined) return;
  if (target === null) {
    log(`no ${PREV_KEYS.has(key) ? 'prev' : 'next'} day from ${current?.date ?? '?'}`);
    return;
  }
  loadDay(target);
}

/**
 * Everything crossing the host boundary is validated before it reaches React:
 * a malformed payload falls back to the bundled sample rather than rendering
 * a half-built tree or throwing inside a commit.
 */
export function loadList(): TodoList {
  const injected: unknown = globalThis.__eink_data;
  if (injected !== undefined && injected !== null) {
    if (isTodoList(injected)) return injected;
    log(`__eink_data rejected: ${describeTodoListProblem(injected)}; using the bundled sample`);
    return SAMPLE;
  }

  const host = globalThis.__eink;
  if (!host?.fetch) return SAMPLE;

  try {
    const res = host.fetch(LIST_ENDPOINT);
    if (!res.ok) {
      log(`GET ${LIST_ENDPOINT} returned ${res.status}; using the bundled sample`);
      return SAMPLE;
    }
    const body: unknown = res.json();
    if (isTodoList(body)) return body;
    log(`GET ${LIST_ENDPOINT} payload rejected: ${describeTodoListProblem(body)}; using the bundled sample`);
  } catch (err) {
    log(`GET ${LIST_ENDPOINT} failed: ${String(err)}; using the bundled sample`);
  }
  return SAMPLE;
}

export function main(): void {
  if ((globalThis.__eink_app ?? 'todo') === 'crossword') {
    render(React.createElement(CrosswordApp));
    return;
  }
  registerKeys(onKey);
  showTodo(loadList());
}

main();
