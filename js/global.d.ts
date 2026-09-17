import type {
  DamageRect, EinkHost, EinkPaintProps, EinkStyle, Loose, NodeId,
} from './host/eink.js';
import type * as React from 'react';

/** Payload passed to `onTap`; `target` is the node the host actually hit. */
export interface TapPayload {
  readonly id: NodeId;
  readonly x: number;
  readonly y: number;
  readonly target: NodeId;
  /** For a tap on <eink-markdown>: the source line of the task under the finger. */
  readonly line?: number;
  stopPropagation(): void;
}

export type TapHandler = (ev: TapPayload) => void;

// React.Attributes supplies `key`; intrinsic elements do not get it for free.
interface EinkCommonProps extends Loose<EinkPaintProps>, React.Attributes {
  style?: Loose<EinkStyle> | undefined;
  onTap?: TapHandler | undefined;
}

export interface EinkBoxIntrinsicProps extends EinkCommonProps {
  children?: React.ReactNode;
}

export interface EinkTextIntrinsicProps extends EinkCommonProps {
  /** A single string or number child becomes the `text` prop. */
  children?: string | number | undefined;
}

/** A markdown document laid out and painted by the core; taps report the task line. */
export interface EinkMarkdownIntrinsicProps extends EinkCommonProps {
  text: string;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'eink-box': EinkBoxIntrinsicProps;
      'eink-text': EinkTextIntrinsicProps;
      'eink-markdown': EinkMarkdownIntrinsicProps;
    }
  }

  var __eink: EinkHost | undefined;
  var __eink_paint: ((damage: DamageRect[]) => void) | undefined;
  /** The Kindle host installs this so the app can quit back to the launcher. */
  var __eink_exit: (() => void) | undefined;
  /** Raw list payload injected by the host; always validated before use. */
  var __eink_data: unknown;
  var __eink_app: string | undefined;
}
