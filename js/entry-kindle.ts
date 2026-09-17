// QuickJS entry point. The host installs globalThis.__eink, setTimeout and
// clearTimeout before evaluating this bundle, and may install __eink_data
// (the todo list) and __eink_app ("todo" | "crossword").
import React from 'react';
import { registerKeys, render } from './renderer/index.js';
import { TodoApp } from './apps/todo/index.js';
import { CrosswordApp } from './apps/crossword/index.js';
import { SAMPLE } from './apps/todo/sample.js';
import { pageButton } from './device/index.js';
import { installLocalStorage, readJson, writeJson } from './storage/index.js';
import {
  countItems, describeTodoListProblem, isTodoList, type TodoList,
} from './apps/todo/schema.js';

const API = 'https://kindle-todo-one.vercel.app';
const LIST_ENDPOINT = `${API}/api/list`;
/** A failed start-up fetch (Wi-Fi not up yet) is retried on this cadence until the list arrives. */
const RETRY_MS = 30_000;


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
  render(React.createElement(TodoApp, {
    key: data.date, data, api: API, onHeaderTap: refresh, onFooterTap: exitToKindle,
  }));
}

/** Header tap: refetch the shown day (or today's list if we are still on a fallback). */
export function refresh(): void {
  log('header tap: refresh');
  if (current && current !== SAMPLE && current.date !== initialList().date) void loadDay(current.date);
  else void refreshList();
  globalThis.__eink?.request_full();
}

/** Footer tap: hand the screen back to the Kindle UI. */
export function exitToKindle(): void {
  log('footer tap: exit');
  globalThis.__eink_exit?.();
}

const LAST_LIST_KEY = 'todo:last';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function fetchList(url: string): Promise<TodoList | null> {
  const host = globalThis.__eink;
  if (!host?.fetch) return null;
  const res = await host.fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!isTodoList(body)) throw new Error(describeTodoListProblem(body));
  return body;
}

/** Fetches one day and shows it. Every failure path logs and leaves the screen alone. */
export async function loadDay(date: string): Promise<void> {
  log(`day switch target: ${date}`);
  try {
    const list = await fetchList(`${LIST_ENDPOINT}?date=${encodeURIComponent(date)}`);
    if (list) showTodo(list);
    else log(`loadDay ${date}: host has no fetch`);
  } catch (err) {
    log(`loadDay ${date} failed: ${errorText(err)}`);
  }
}

export function onKey(key: string): void {
  log(`key received: ${key}`);
  const button = pageButton(key);
  const target = button === 'left' ? current?.prev : button === 'right' ? current?.next : undefined;
  if (target === undefined) return;
  if (target === null) {
    log(`no ${button === 'left' ? 'prev' : 'next'} day from ${current?.date ?? '?'}`);
    return;
  }
  void loadDay(target);
}

/**
 * Everything crossing the host boundary is validated before it reaches React: a malformed
 * payload falls back to the last good list, then the bundled sample, rather than rendering
 * a half-built tree or throwing inside a commit.
 */
export function initialList(): TodoList {
  const injected: unknown = globalThis.__eink_data;
  if (injected !== undefined && injected !== null) {
    if (isTodoList(injected)) return injected;
    log(`__eink_data rejected: ${describeTodoListProblem(injected)}`);
  }
  const last = readJson<unknown>(LAST_LIST_KEY, null);
  if (isTodoList(last)) return last;
  return SAMPLE;
}

/** Shows the live list when it arrives; while it has not, keeps retrying in the background. */
export async function refreshList(): Promise<boolean> {
  try {
    const list = await fetchList(LIST_ENDPOINT);
    if (!list) return false;
    writeJson(LAST_LIST_KEY, list);
    showTodo(list);
    return true;
  } catch (err) {
    log(`GET ${LIST_ENDPOINT} failed: ${errorText(err)}`);
    return false;
  }
}

function retryUntilLive(): void {
  void refreshList().then((ok) => {
    if (ok) return;
    log(`live list unavailable; retrying in ${RETRY_MS / 1000}s`);
    setTimeout(retryUntilLive, RETRY_MS);
  });
}

export function main(): void {
  installLocalStorage();
  if ((globalThis.__eink_app ?? 'todo') === 'crossword') {
    render(React.createElement(CrosswordApp));
    return;
  }
  registerKeys(onKey);
  // paint at once with whatever is at hand, then replace it with the live list
  showTodo(initialList());
  if (globalThis.__eink?.fetch) retryUntilLive();
}

main();
