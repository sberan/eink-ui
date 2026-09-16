# eink-ui — the JavaScript half

TypeScript (strict), React 18 and `react-reconciler` rendering straight into the
`eink-core` scene tree exposed as `globalThis.__eink`, plus a browser simulator
that doubles as the component gallery, and the Kindle/QuickJS bundle.

    npm install

## Layout

| path | what it is |
| --- | --- |
| `host/eink.ts` | the typed contract for `globalThis.__eink`; every host asserts `const _check: EinkHost = api` |
| `global.d.ts` | `JSX.IntrinsicElements` for `eink-box` / `eink-text`, and the `__eink*` globals |
| `renderer/` | the react-reconciler host config, prop diffing, `render`/`unmount`, `useKeys` |
| `components/` | View, Row, Column, Text, Button, Checkbox, Grid, Keyboard |
| `apps/todo/` | the list app; `schema.ts` validates anything crossing the host boundary |
| `apps/crossword/` | the 9x9 mini |
| `stories/` | plain TS story modules (a `Meta` default export + named `Story` functions) and the registry the gallery reads |
| `sim/` | the simulator + gallery, the pure-TS mock host, and the wasm glue |
| `entry-kindle.ts` | the QuickJS entry point: day loading, page-turn keys, device logging |

## Simulator and gallery

    npm run sim           # http://127.0.0.1:5173

One page serves both jobs. The left sidebar lists the two apps and every
component story; selecting one unmounts the previous tree and mounts the new one
through `renderer/index.ts` into the wasm host, painted with real e-ink waveform
timing (DU 260 ms, GC16 450 ms with a black flash). The status bar keeps
counting partials since the last full refresh, and "Full refresh" forces a GC16.

Routes are hash-based and deep-linkable:

| route | shows |
| --- | --- |
| `#/` | the gallery with the first component story selected |
| `#/app/todo`, `#/app/crossword` | the apps |
| `#/story/<id>` | one story, e.g. `#/story/keyboard--typing` |

Click the canvas to send `{type:"tap", id: __eink.hit(x,y), x, y}`; type on a
physical keyboard to send `{type:"key", key}`. The page uses the wasm build of
`eink-core` when `sim/pkg/eink_wasm.wasm` is present, otherwise the pure-TS host
in `sim/mock-eink.ts`; the status bar says which one is live.

### Adding a story

A story module is plain TypeScript — no framework imports:

```tsx
import type { Meta, Story } from './kit.js';

const meta: Meta = { title: 'Components/Thing' };
export default meta;

export const Default: Story = () => <Page>…</Page>;
```

Then add the module to `stories/index.ts`. The sidebar label comes from the
export name unless the story sets `storyName`.

## Type safety

`tsconfig.json` runs `strict`, `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. The last one is load-bearing: payload types such as
`EinkFetchOptions` reject a present-but-undefined key, which is how the `fetch`
shim shipped a bug. React-facing prop types opt back in through `Loose<T>` in
`host/eink.ts`, so `<View style={maybeUndefined} />` still works while the host
boundary stays exact.

## Build

    ./build.sh            # sim/pkg/eink_wasm.js, dist/app.js, dist/sim.js
    npm run build:pages   # -> pages/  (the simulator, ready for GitHub Pages)

`dist/app.js` is the Kindle bundle: IIFE, ES2020, minified, React in production
mode. `scripts/check-kindle-bundle.ts` fails the build if it reaches for a DOM
global or `process`.

`pages/` holds `index.html`, `app.js` and `pkg/` with every path relative, so it
works unchanged under `https://<user>.github.io/<repo>/`.

## Test

    npm test              # typecheck + vitest
    npm run typecheck     # tsc --noEmit
    npm run test:unit     # vitest only
