import React, { useState } from 'react';
import { Button, Row, Column, Text } from '../components/index.js';
import { Page } from './kit.js';
import type { Meta, Story } from './kit.js';

const meta: Meta = { title: 'Components/Button' };
export default meta;

export const Default: Story = () => (
  <Page>
    <Button label="Tap me" style={{ height: 96, width: 420 }} />
    <Button label="Bold label" bold style={{ height: 96, width: 420 }} />
    <Button label="Small" font_size={24} style={{ height: 64, width: 260 }} />
    <Button label="Disabled" disabled style={{ height: 96, width: 420 }} />
  </Page>
);

/** Tap a button: the bg flips for 140 ms, which the panel shows as a DU partial. */
export const PressedFeedback: Story = () => (
  <Page>
    <Text font_size={28}>Tap a button to see the bg flip and the DU rect in the status line.</Text>
    <Row style={{ gap: 20, height: 110 }}>
      <Button label="140 ms" style={{ flex_grow: 1, height: 110 }} />
      <Button label="600 ms" flash={600} style={{ flex_grow: 1, height: 110 }} />
      <Button label="inverted" bg={0} color={255} pressedBg={255} pressedColor={0} style={{ flex_grow: 1, height: 110 }} />
    </Row>
  </Page>
);

function Counter() {
  const [n, setN] = useState(0);
  return (
    <Column style={{ gap: 30 }}>
      <Text font_size={64} bold align="center" style={{ width: 976 }}>{String(n)}</Text>
      <Row style={{ gap: 20, height: 120 }}>
        <Button label="minus" onTap={() => setN((v) => v - 1)} style={{ flex_grow: 1, height: 120 }} />
        <Button label="plus" onTap={() => setN((v) => v + 1)} style={{ flex_grow: 1, height: 120 }} />
      </Row>
    </Column>
  );
}

export const WithState: Story = () => <Page><Counter /></Page>;
