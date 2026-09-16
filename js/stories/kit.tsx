import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { AlignItems, Sides } from '../host/eink.js';

/** A module's default export names its group in the gallery sidebar. */
export interface Meta {
  readonly title: string;
}

/** A named export of a story module: a function returning one eink element tree. */
export interface Story {
  (): ReactElement;
  /** Overrides the label derived from the export name. */
  storyName?: string;
}

export const PANEL_W = 1072;
export const PANEL_H = 1448;

export interface PageProps {
  children?: ReactNode;
  gap?: number;
  padding?: Sides;
  align?: AlignItems | undefined;
}

/** A full white panel with page padding, for stories that show a single widget. */
export function Page({ children, gap = 24, padding = 48, align }: PageProps) {
  return (
    <eink-box
      bg={255}
      style={{
        width: PANEL_W, height: PANEL_H, flex_direction: 'column', padding, gap,
        align_items: align,
      }}
    >
      {children}
    </eink-box>
  );
}
