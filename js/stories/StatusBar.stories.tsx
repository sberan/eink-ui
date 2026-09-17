import React from 'react';
import { Column, StatusBar, Text } from '../components/index.js';
import { Page } from './kit.js';
import type { Meta, Story } from './kit.js';

const meta: Meta = { title: 'Components/StatusBar' };
export default meta;

const at = new Date(Date.UTC(2026, 8, 17, 9, 41));

export const States: Story = () => (
  <Page gap={40}>
    <Column style={{ gap: 6 }}>
      <Text font_size={24} color={140}>Full, with a title</Text>
      <StatusBar title="kindle-todo" battery={{ percent: 98, charging: false }} time={at} />
    </Column>
    <Column style={{ gap: 6 }}>
      <Text font_size={24} color={140}>Low</Text>
      <StatusBar battery={{ percent: 12, charging: false }} time={at} />
    </Column>
    <Column style={{ gap: 6 }}>
      <Text font_size={24} color={140}>Charging</Text>
      <StatusBar battery={{ percent: 55, charging: true }} time={at} />
    </Column>
    <Column style={{ gap: 6 }}>
      <Text font_size={24} color={140}>Black, larger</Text>
      <StatusBar title="Sync 3 min ago" battery={{ percent: 80, charging: false }} time={at} color={0} font_size={30} />
    </Column>
  </Page>
);

/** Reads the host: the simulator's battery knob and the real clock. */
export const Live: Story = () => <Page><StatusBar title="live from the host" /></Page>;
