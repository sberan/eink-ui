/**
 * The typed contract for `globalThis.__eink`: the API in docs/ARCHITECTURE.md,
 * mirrored 1:1 by eink-core's wasm and QuickJS bindings, plus the extras the
 * Kindle host adds (log, buzz, fetch, charging, now).
 *
 * Every implementation in this repo asserts conformance with
 * `const _check: EinkHost = api;`.
 */

export type NodeId = number;

/** `create(kind)` takes the lowercase name of eink_core::Kind. */
export type NodeKind = 'box' | 'text';

/** "du" = fast B/W partial, "gc16" = full quality flash. */
export type RefreshMode = 'du' | 'gc16';

export interface DamageRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly mode: RefreshMode;
}

export type TapEvent = { readonly type: 'tap'; readonly id: NodeId; readonly x: number; readonly y: number };
export type KeyEvent = { readonly type: 'key'; readonly key: string };
export type EinkInputEvent = TapEvent | KeyEvent;

export type EinkListener = (ev: EinkInputEvent) => void;

/** `on` returns an unsubscribe where the host can offer one; the Kindle cannot. */
export type Unsubscribe = () => void;

/** A web-fetch-shaped response: the request ran on a host thread, nothing blocked the UI. */
export interface EinkFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface EinkFetchOptions {
  readonly method?: string;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

export interface BatteryState {
  /** 0..100 */
  readonly percent: number;
  readonly charging: boolean;
}

export interface EinkHost {
  readonly width: number;
  readonly height: number;

  create(kind: NodeKind): NodeId;
  /** Partial update; `json` is a serialised `EinkProps`. */
  set_props(id: NodeId, json: string): void;
  append(parent: NodeId, child: NodeId): void;
  insert_before(parent: NodeId, child: NodeId, before: NodeId): void;
  remove(parent: NodeId, child: NodeId): void;
  set_root(id: NodeId): void;
  commit(): DamageRect[];
  /** Deepest node with `hit: true` at (x, y), or 0. */
  hit(x: number, y: number): NodeId;
  request_full(): void;
  /** 8-bit grayscale, row-major, `width * height` bytes. Re-read after each commit. */
  fb(): Uint8Array;
  on(cb: EinkListener): Unsubscribe | void;

  log(msg: string): void;
  buzz(): void;
  charging(): boolean;
  battery(): BatteryState;
  /** Milliseconds since the epoch, like Date.now(). */
  now(): number;
  /** Local time offset in minutes east of UTC, from the device's own clock settings. */
  tz_offset(): number;
  /** Persistent key/value storage for UI state: a JSON file on the device, localStorage in the browser. */
  storage_get(key: string): string | null;
  storage_set(key: string, value: string): void;
  storage_remove(key: string): void;
  storage_keys(): string[];
  /** Present on the Kindle (also installed as globalThis.fetch); absent in the simulator and tests. */
  fetch?(url: string, opts?: EinkFetchOptions): Promise<EinkFetchResponse>;
}

/** Hosts driven from a browser UI (the simulator and gallery) also inject input. */
export interface SimulatedEinkHost extends EinkHost {
  emit(ev: EinkInputEvent): void;
}

// ---- scene props (mirrors eink_core::Props / StyleProps) -------------------

/** A number is pixels; "auto", "50%" and "12px" are also accepted. */
export type LengthValue = number | 'auto' | string;

export type FlexDirection = 'row' | 'column';
export type FlexWrap = 'nowrap' | 'wrap';
export type JustifyContent =
  | 'start' | 'flex-start' | 'center' | 'end' | 'flex-end'
  | 'space-between' | 'space-around' | 'space-evenly';
export type AlignItems = 'start' | 'flex-start' | 'center' | 'end' | 'flex-end' | 'stretch';
export type PositionValue = 'relative' | 'absolute';
export type DisplayValue = 'flex' | 'none';
export type TextAlign = 'left' | 'center' | 'right';

/** number = all four sides, or [top, right, bottom, left]. */
export type Sides = number | readonly [number, number, number, number];

/** The Taffy subset exposed to JS, snake_case exactly as eink-core deserialises it. */
export interface EinkStyle {
  width?: LengthValue;
  height?: LengthValue;
  min_width?: LengthValue;
  min_height?: LengthValue;
  max_width?: LengthValue;
  max_height?: LengthValue;
  flex_direction?: FlexDirection;
  flex_wrap?: FlexWrap;
  justify_content?: JustifyContent;
  align_items?: AlignItems;
  align_self?: AlignItems;
  flex_grow?: number;
  flex_shrink?: number;
  flex_basis?: LengthValue;
  gap?: number;
  padding?: Sides;
  margin?: Sides;
  position?: PositionValue;
  top?: number | null;
  left?: number | null;
  right?: number | null;
  bottom?: number | null;
  display?: DisplayValue;
}

/** Paint props. `bg: null` is transparent, which is why it is nullable. */
export interface EinkPaintProps {
  bg?: number | null;
  border?: number;
  border_color?: number;
  color?: number;
  text?: string;
  font_size?: number;
  bold?: boolean;
  align?: TextAlign;
  hit?: boolean;
  radius?: number;
}

export interface EinkProps extends EinkPaintProps {
  style?: EinkStyle;
}

/** What `set_props` serialises: partial paint props plus a partial style. */
export type EinkPropsPayload = EinkProps;

/**
 * React props may legitimately be present-but-undefined (`<View style={maybe} />`),
 * while a payload serialised to the host may not: `exactOptionalPropertyTypes`
 * keeps the two apart. `Loose<T>` is the React-facing form of a payload type.
 */
export type Loose<T> = { [K in keyof T]?: T[K] | undefined };

export type EinkStyleProp = Loose<EinkStyle>;
