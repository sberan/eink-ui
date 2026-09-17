import React from 'react';
import { Text, Column } from '../components/index.js';
import { Page } from './kit.js';
import type { Meta, Story } from './kit.js';

const meta: Meta = { title: 'Components/Text' };
export default meta;

export const Sizes: Story = () => (
  <Page>
    <Text font_size={52} bold>Noto Serif 52 bold</Text>
    <Text font_size={38}>Noto Serif 38 regular</Text>
    <Text font_size={32}>Noto Serif 32 regular</Text>
    <Text font_size={28}>Noto Serif 28, the smallest body size</Text>
    <Text font_size={24}>Noto Serif 24, the smallest caption size</Text>
  </Page>
);

export const Alignment: Story = () => (
  <Page>
    <Text font_size={34} align="left" style={{ width: 976 }}>Left aligned</Text>
    <Text font_size={34} align="center" style={{ width: 976 }}>Centre aligned</Text>
    <Text font_size={34} align="right" style={{ width: 976 }}>Right aligned</Text>
  </Page>
);

export const Wrapping: Story = () => (
  <Page>
    <Column style={{ gap: 30 }}>
      <Text font_size={32} style={{ width: 600 }}>
        A long label constrained to 600px: eink-core measures text with fontdue and
        Taffy wraps it, so the renderer never has to know about line breaking.
      </Text>
      <Text font_size={32} style={{ width: 976 }}>
        The same paragraph across the full page width, which needs fewer lines.
      </Text>
    </Column>
  </Page>
);
