import React, { useCallback, useState } from 'react';
import { Keyboard, KEYBOARD_HEIGHT, Text } from '../components/index.js';
import { useKeys } from '../renderer/useKeys.js';
import type { Meta, Story } from './kit.js';

const meta: Meta = { title: 'Components/Keyboard' };
export default meta;

function Panel({ children }: { children?: React.ReactNode }) {
  return (
    <eink-box bg={255} style={{ width: 1072, height: 1448, flex_direction: 'column' }}>
      {children}
    </eink-box>
  );
}

export const Default: Story = () => (
  <Panel>
    <eink-box style={{ flex_grow: 1, padding: 48 }}>
      <Text font_size={30} color={90}>380px tall, pinned to the bottom of the panel.</Text>
    </eink-box>
    <Keyboard />
  </Panel>
);

function TypingDemo() {
  const [text, setText] = useState('');
  const onKey = useCallback((k: string) => {
    setText((t) => {
      if (k === 'BACKSPACE') return t.slice(0, -1);
      if (k === 'ENTER') return `${t}\n`;
      return t + k;
    });
  }, []);
  // the physical keyboard reaches the story through the same focus model
  useKeys(onKey);
  return (
    <Panel>
      <eink-box style={{ flex_grow: 1, padding: 48, gap: 20 }}>
        <Text font_size={28} color={90}>Tap keys, or use the physical keyboard.</Text>
        <eink-box bg={245} border={2} border_color={0} style={{ height: 200, padding: 20 }}>
          <eink-text text={text || ' '} font_size={40} style={{ width: 936 }} />
        </eink-box>
      </eink-box>
      <Keyboard onKey={onKey} />
    </Panel>
  );
}

export const Typing: Story = () => <TypingDemo />;

export const AboveAClueLine: Story = () => (
  <Panel>
    <eink-box style={{ flex_grow: 1 }} />
    <eink-box bg={235} style={{ height: 76, justify_content: 'center', padding: [0, 60, 0, 60] }}>
      <eink-text text="1A  Informal talk" font_size={32} />
    </eink-box>
    <Keyboard style={{ height: KEYBOARD_HEIGHT }} />
  </Panel>
);
AboveAClueLine.storyName = 'Above a clue line';
