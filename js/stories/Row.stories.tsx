import React from 'react';
import { Row } from '../components/index.js';
import type { AlignItems as AlignItemsValue, JustifyContent } from '../host/eink.js';
import { Page } from './kit.js';
import type { Meta, Story } from './kit.js';

const meta: Meta = { title: 'Components/Row' };
export default meta;

interface CellProps { w?: number; label: string; grow?: number }

const Cell = ({ w, label, grow }: CellProps) => (
  <eink-box
    bg={255}
    border={2}
    border_color={0}
    style={{ width: w, height: 110, flex_grow: grow, align_items: 'center', justify_content: 'center' }}
  >
    <eink-text text={label} font_size={26} align="center" />
  </eink-box>
);

export const Justify: Story = () => (
  <Page gap={20}>
    {(['start', 'center', 'end', 'space-between', 'space-around', 'space-evenly'] as const satisfies readonly JustifyContent[]).map((j) => (
      <Row key={j} bg={255} border={2} style={{ justify_content: j, gap: 12, height: 130, padding: 10 }}>
        <Cell w={200} label={j} />
        <Cell w={140} label="b" />
        <Cell w={140} label="c" />
      </Row>
    ))}
  </Page>
);

export const AlignItems: Story = () => (
  <Page gap={24}>
    {(['start', 'center', 'end', 'stretch'] as const satisfies readonly AlignItemsValue[]).map((a) => (
      <Row key={a} bg={255} border={2} style={{ align_items: a, gap: 16, height: 200, padding: 12 }}>
        <eink-box bg={255} border={2} style={{ width: 200, height: 70, align_items: 'center', justify_content: 'center' }}>
          <eink-text text={a} font_size={26} />
        </eink-box>
        <eink-box bg={255} border={2} style={{ width: 160, height: 120 }} />
        <eink-box bg={255} border={2} style={{ width: 160 }} />
      </Row>
    ))}
  </Page>
);

export const Grow: Story = () => (
  <Page gap={24}>
    <Row style={{ gap: 12, height: 130 }}>
      <Cell label="grow 1" grow={1} />
      <Cell label="grow 1" grow={1} />
      <Cell label="grow 2" grow={2} />
    </Row>
    <Row style={{ gap: 12, height: 130 }}>
      <Cell w={240} label="fixed 240" />
      <Cell label="fills the rest" grow={1} />
    </Row>
  </Page>
);
