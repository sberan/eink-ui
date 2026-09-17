import React from 'react';
import { Column, Row } from '../components/index.js';
import { Page } from './kit.js';
import type { Meta, Story } from './kit.js';

const meta: Meta = { title: 'Components/Column' };
export default meta;

interface BandProps { h?: number; label: string; grow?: number }

const Band = ({ h, label, grow }: BandProps) => (
  <eink-box
    bg={255}
    border={2}
    border_color={0}
    style={{ height: h, flex_grow: grow, justify_content: 'center', padding: [0, 20, 0, 20] }}
  >
    <eink-text text={label} font_size={28} />
  </eink-box>
);

export const Stacked: Story = () => (
  <Page>
    <Column style={{ gap: 18 }}>
      <Band h={100} label="first" />
      <Band h={100} label="second" />
      <Band h={100} label="third" />
    </Column>
  </Page>
);

export const Grow: Story = () => (
  <Page>
    <Column style={{ gap: 18, height: 1100 }}>
      <Band h={110} label="header, fixed 110" />
      <Band label="body, flex_grow 1" grow={1} />
      <Band h={90} label="footer, fixed 90" />
    </Column>
  </Page>
);

export const Nested: Story = () => (
  <Page>
    <Column style={{ gap: 20 }}>
      <Band h={90} label="column" />
      <Row style={{ gap: 20, height: 300 }}>
        <Column style={{ gap: 12, flex_grow: 1 }}>
          <Band label="row > column" grow={1} />
          <Band label="row > column" grow={1} />
        </Column>
        <Column style={{ gap: 12, flex_grow: 2 }}>
          <Band label="wider column" grow={1} />
        </Column>
      </Row>
    </Column>
  </Page>
);
