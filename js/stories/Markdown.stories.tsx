import React, { useState } from 'react';
import { Markdown, toggleTaskLine } from '../components/index.js';
import { SAMPLE_FILES } from '../files/sample.js';
import { Page } from './kit.js';
import type { Meta, Story } from './kit.js';

const meta: Meta = { title: 'Components/Markdown' };
export default meta;

export const Notes: Story = () => <Page><Markdown text={SAMPLE_FILES['notes/readme.md']!} /></Page>;

function Tasks() {
  const [text, setText] = useState(SAMPLE_FILES['days/2026-09-15.md']!);
  return <Markdown text={text} onToggleTask={(line) => setText((t) => toggleTaskLine(t, line))} />;
}

/** Tap a task: only its row repaints, and the source line flips between [ ] and [x]. */
export const TaskList: Story = () => <Page><Tasks /></Page>;
