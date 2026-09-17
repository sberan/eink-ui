import React, { useCallback, useState } from 'react';
import { Grid, Text } from '../components/index.js';
import { Page } from './kit.js';
import type { Meta, Story } from './kit.js';

const meta: Meta = { title: 'Components/Grid' };
export default meta;

interface BoxProps { label: string; bg?: number }

const Box = ({ label, bg = 255 }: BoxProps) => (
  <eink-box
    bg={bg}
    border={2}
    border_color={0}
    style={{ width: 96, height: 96, align_items: 'center', justify_content: 'center' }}
  >
    <eink-text text={label} font_size={30} align="center" />
  </eink-box>
);

export const NineByNine: Story = () => (
  <Page>
    <Grid cols={9} rows={9} cell={96}>
      {Array.from({ length: 81 }, (_, i) => <Box key={i} label={String(i + 1)} bg={i % 10 === 0 ? 0 : 255} />)}
    </Grid>
  </Page>
);

export const WithGap: Story = () => (
  <Page>
    <Grid cols={5} rows={4} cell={96} gap={12}>
      {Array.from({ length: 20 }, (_, i) => <Box key={i} label={String.fromCharCode(65 + i)} />)}
    </Grid>
  </Page>
);

function Selectable() {
  const [sel, setSel] = useState(0);
  const pick = useCallback((i: number) => setSel(i), []);
  return (
    <>
      <Text font_size={28}>Tap a cell: only two cells repaint.</Text>
      <Grid cols={6} rows={6} cell={96} gap={4}>
        {Array.from({ length: 36 }, (_, i) => (
          <eink-box
            key={i}
            hit
            onTap={() => pick(i)}
            bg={sel === i ? 220 : 255}
            border={2}
            border_color={0}
            style={{ width: 96, height: 96, align_items: 'center', justify_content: 'center' }}
          >
            <eink-text text={String(i)} font_size={28} align="center" />
          </eink-box>
        ))}
      </Grid>
    </>
  );
}

export const Selection: Story = () => <Page><Selectable /></Page>;
