import React from 'react';
import { View } from '../components/index.js';
import { Page } from './kit.js';
import type { Meta, Story } from './kit.js';

const meta: Meta = { title: 'Components/View' };
export default meta;

interface SwatchProps { bg: number; label: string; border?: number }

const Swatch = ({ bg, label, border = 0 }: SwatchProps) => (
  <View
    bg={bg}
    border={border}
    border_color={0}
    style={{ height: 120, align_items: 'center', justify_content: 'center' }}
  >
    <eink-text text={label} font_size={30} color={bg < 128 ? 255 : 0} />
  </View>
);

export const Backgrounds: Story = () => (
  <Page>
    <Swatch bg={255} label="bg 255 (paper)" border={2} />
    <Swatch bg={220} label="bg 220 (selection)" />
    <Swatch bg={150} label="bg 150" />
    <Swatch bg={60} label="bg 60" />
    <Swatch bg={0} label="bg 0 (ink)" />
  </Page>
);

export const Borders: Story = () => (
  <Page>
    <View border={1} border_color={0} style={{ height: 90, justify_content: 'center', padding: 16 }}>
      <eink-text text="border 1" font_size={28} />
    </View>
    <View border={3} border_color={0} style={{ height: 90, justify_content: 'center', padding: 16 }}>
      <eink-text text="border 3" font_size={28} />
    </View>
    <View border={8} border_color={90} style={{ height: 110, justify_content: 'center', padding: 16 }}>
      <eink-text text="border 8 at gray 90" font_size={28} />
    </View>
  </Page>
);

export const PaddingAndGap: Story = () => (
  <Page>
    <View bg={235} style={{ padding: 40, gap: 20 }}>
      <View bg={0} style={{ height: 40 }} />
      <View bg={0} style={{ height: 40 }} />
      <View bg={0} style={{ height: 40 }} />
    </View>
    <View bg={235} style={{ padding: [10, 80, 10, 80], gap: 6 }}>
      <View bg={0} style={{ height: 40 }} />
      <View bg={0} style={{ height: 40 }} />
    </View>
  </Page>
);
