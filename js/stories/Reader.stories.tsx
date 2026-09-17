import React from 'react';
import { ReaderApp } from '../apps/reader/index.js';
import type { Meta, Story } from './kit.js';

const meta: Meta = { title: 'Apps/Reader' };
export default meta;

/** The whole reader over the simulator's sample repository: page buttons switch days, taps tick. */
export const Days: Story = () => <ReaderApp />;
