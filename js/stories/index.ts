// The gallery registry the simulator renders from: plain modules, no framework.
import type { Meta, Story } from './kit.js';
import * as ButtonStories from './Button.stories.js';
import * as CheckboxStories from './Checkbox.stories.js';
import * as ColumnStories from './Column.stories.js';
import * as GridStories from './Grid.stories.js';
import * as KeyboardStories from './Keyboard.stories.js';
import * as RowStories from './Row.stories.js';
import * as TextStories from './Text.stories.js';
import * as ViewStories from './View.stories.js';

/** Every story module: a default `Meta` plus named `Story` functions. */
export type StoryModule = { readonly default: Meta } & Record<string, Story | Meta>;

export const STORY_MODULES: readonly StoryModule[] = [
  ViewStories, RowStories, ColumnStories, TextStories,
  ButtonStories, CheckboxStories, GridStories, KeyboardStories,
];

export interface StoryEntry {
  readonly id: string;
  readonly group: string;
  readonly name: string;
  readonly render: Story;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Splits camel case so both the id and the label keep word boundaries. */
const words = (exportName: string) => exportName
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .split(' ');

/**
 * "WithState" -> "with-state". Derived from the export name, not `storyName`,
 * so renaming a label never breaks a deep link.
 */
function storyId(group: string, exportName: string): string {
  return `${slug(group)}--${slug(words(exportName).join('-'))}`;
}

/** "NineByNine" -> "Nine by nine"; `storyName` wins when a story sets it. */
function label(exportName: string): string {
  const [first = '', ...rest] = words(exportName);
  return [first, ...rest.map((w) => (w.length > 2 ? w.toLowerCase() : w))].join(' ');
}

function entriesOf(mod: StoryModule): StoryEntry[] {
  const group = mod.default.title.split('/').pop() ?? mod.default.title;
  const out: StoryEntry[] = [];
  for (const [key, value] of Object.entries(mod)) {
    if (key === 'default' || typeof value !== 'function') continue;
    out.push({
      id: storyId(group, key),
      group,
      name: value.storyName ?? label(key),
      render: value,
    });
  }
  return out;
}

export const STORIES: readonly StoryEntry[] = STORY_MODULES.flatMap(entriesOf);

export function findStory(id: string): StoryEntry | undefined {
  return STORIES.find((s) => s.id === id);
}
