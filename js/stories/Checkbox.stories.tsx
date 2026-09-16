import React, { useCallback, useState } from 'react';
import { Checkbox, Column, Text } from '../components/index.js';
import { Page } from './kit.js';
import type { Meta, Story } from './kit.js';

const meta: Meta = { title: 'Components/Checkbox' };
export default meta;

export const States: Story = () => (
  <Page>
    <Checkbox checked={false} label="Unchecked, 30px box" />
    <Checkbox checked label="Checked, 30px box" />
    <Checkbox checked={false} label="Larger box and label" size={44} font_size={40} />
    <Checkbox checked label="Dimmed label" color={140} />
  </Page>
);

function InteractiveList() {
  const [done, setDone] = useState<Record<number, boolean>>({});
  const toggle = useCallback((id: number) => setDone((d) => ({ ...d, [id]: !d[id] })), []);
  const items = ['Charge the Voyage', 'Flash the new bundle', 'Check the ghosting counter'];
  return (
    <Column style={{ gap: 22 }}>
      <Text font_size={28} color={90}>Tap a row: one checkbox repaints, nothing else.</Text>
      {items.map((label, i) => (
        <Checkbox
          key={label}
          label={label}
          checked={done[i] ?? false}
          onTap={() => toggle(i)}
          style={{ height: 60 }}
        />
      ))}
    </Column>
  );
}

export const Interactive: Story = () => <Page><InteractiveList /></Page>;
