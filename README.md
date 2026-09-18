<p align="center">
  <img src="https://sberan.github.io/eink-ui/todo.png" alt="Todo list rendered by eink-ui" width="360">
  &nbsp;&nbsp;
  <img src="https://sberan.github.io/eink-ui/crossword.png" alt="Crossword with on-screen keyboard rendered by eink-ui" width="360">
</p>
<p align="center"><sub>Both images are rendered by the engine itself on every deploy: the live todo list, and the crossword after typing a word.</sub></p>

<h1 align="center">eink-ui</h1>

<p align="center">
  <a href="https://sberan.github.io/eink-ui/"><b>Live simulator &amp; component gallery</b></a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/DEBUGGING.md">Remote debugging</a>
</p>

<p align="center">
  <a href="https://github.com/sberan/eink-ui/actions/workflows/ci.yml"><img src="https://github.com/sberan/eink-ui/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/sberan/eink-ui/actions/workflows/pages.yml"><img src="https://github.com/sberan/eink-ui/actions/workflows/pages.yml/badge.svg" alt="pages"></a>
  <img src="https://img.shields.io/badge/rust-static%20musl-orange" alt="rust">
  <img src="https://img.shields.io/badge/typescript-strict-blue" alt="typescript">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
</p>

A React UI toolkit for e-ink screens, built for a jailbroken Kindle Voyage. React components
drive a Rust layout and rasterization core; only the pixels that changed are pushed to the
panel, and the process sleeps between events.

```
React components ──► react-reconciler host ──► eink-core (Rust: Taffy flexbox, fontdue text,
                                                damage tracking)  ──► e-ink panel (EPDC ioctls)
                                                                  └─► browser canvas (wasm sim)
```

- **Partial refresh by construction.** `Scene::commit()` diffs the scene against the last
  frame and returns the rects that changed. A checkbox toggle refreshes ~2% of the panel.
- **Zero cost when idle.** The Kindle host blocks on input; JavaScript runs only for events
  and timers.
- **One engine everywhere.** The same Rust core runs on the device (QuickJS host) and in the
  browser (wasm) for the simulator and Storybook.
- **Flexbox layout** via [Taffy](https://github.com/DioxusLabs/taffy), text via
  [fontdue](https://github.com/mooman219/fontdue), no FBInk or other native dependencies.

## Try it in the browser

**[Open the gallery](https://sberan.github.io/eink-ui/)**: one app with every component and
every demo app as its pages, booted in the browser on the real engine compiled to WebAssembly,
the same Rust core the Kindle runs. Walk the pages with the corner tabs, the arrow keys or the
sidebar; Page Up and Page Down are the device's page buttons and go to the page shown.

It is a debugging tool as well: open Chrome DevTools and the bundle maps back to the TypeScript
sources (source maps are published), `eink` in the console is the host (`eink.hit(x, y)`,
`eink.commit()`), and `gallery.show(id)` jumps to a page. Every refresh is animated with real
e-ink timings (DU ≈ 260 ms, GC16 ≈ 450 ms with a flash), and the status line shows the rects and
the refreshed area of each commit. Locally:

```sh
./build.sh wasm          # builds the core to js/sim/pkg/eink_wasm.wasm (Docker)
cd js && npm install
npm run sim              # http://127.0.0.1:5173
```

The gallery is an ordinary app of the kit (`js/apps/gallery`), so it can also be installed on a
device.

## Make an app

Four commands, like any web project. The device is a git remote's follower: it pulls the
repository, `data/` is the only folder it writes, and settings ride in `package.json`.

```sh
npx eink-ui init my-kindle   # the repository and the example app (git init, npm install)
cd my-kindle
npm run dev                  # http://127.0.0.1:5173: your app on the real core, rebuilt as you save
npm run build                # dist/app.js and bin/eink-host (the host at eink-ui's version)
npm run sync                 # commit, push, and tell a reachable device (ssh kindle) to pull
```

`package.json` is the whole contract: `main` is the bundle the device runs, the `eink` section
its settings (see [docs/DEBUGGING.md](docs/DEBUGGING.md)), and the `eink-ui` dependency
version is the host version that `build` puts in `bin/`. Debugging is `ssh kindle eink ...`.

## Run it on a Kindle

Requirements: a jailbroken Kindle with the scriptlet hook (`.sh` files in `documents/` run from
the library). Tested on a Kindle Voyage, firmware 5.13.6. The host talks to `/dev/fb0` and the
EPDC directly; the only runtime dependencies are the stock `lipc-*` tools.

```sh
./build.sh kindle        # static armv7 musl binary with QuickJS + the core
cd js && ./build.sh      # React bundle -> js/dist/app.js
./kindle/install.sh      # copies onto the USB-mounted Kindle
```

Then eject and open **Todo UI** in the library. Tap items to toggle them, PagePress switches
days, a tap on the header redraws, a tap on the footer returns to the Kindle UI.

## Debug it wirelessly

The host listens on TCP 2323: connect with `kindle/debug.sh` for the live log and a JavaScript
REPL inside the running app; `:reload` and `:update` pull new bundles and binaries over Wi-Fi, so
the USB cable is only needed once. Errors at runtime show a small `!` badge in the top-right
corner and the reason in the log. Details in [docs/DEBUGGING.md](docs/DEBUGGING.md).

## Layout of the repository

| Path | What |
|---|---|
| `crates/eink-core` | Scene tree, layout, text, rasterizer, damage tracking. Pure Rust, no I/O. |
| `crates/eink-wasm` | C-ABI wasm exports of the core (no wasm-bindgen). |
| `crates/eink-kindle` | `eink-host`: QuickJS runtime, `/dev/fb0` + EPDC driver, input, power policy. |
| `js/renderer` | react-reconciler host config targeting the core's API. |
| `js/components` | View, Row, Column, Text, Button, Checkbox, Grid, Keyboard, StatusBar, Markdown. All follow [docs/HIG.md](docs/HIG.md): black text, black or white fills, no transient text, no layout shifts. |
| `js/device` | `useBattery`, `useClock`, `usePageButtons`: device state as hooks, with answers that work without a host. |
| `js/storage` | Web-Storage-shaped persistent UI state (`useStoredState`, `installLocalStorage`): a JSON file on the device, localStorage in the browser. |
| `js/files` | The git-synced repository as files: `useFile`, `useFiles`, `writeFile`, `useSync`. A write is a commit; a pull re-renders. |
| `js/apps/reader` | Markdown files from the repository: page buttons move between days, a tap ticks a task, the keyboard adds one. |
| `js/apps` | Todo list and crossword demos. |
| `js/sim` | Browser simulator: component gallery, apps, e-ink refresh timing. |
| `js/stories` | Component stories shown in the simulator's gallery. |
| `kindle/` | Launcher scriptlets, first-time USB install, wireless `push.sh`, `debug.sh`. |
| `docs/` | Architecture and remote debugging guides. |
| `docs/ARCHITECTURE.md` | The host API contract shared by the wasm and QuickJS hosts. |

## Writing an app

```jsx
import { View, Row, Text, Checkbox } from '../components/index.jsx';

export function Hello() {
  const [done, setDone] = useState(false);
  return (
    <View style={{ padding: 40, gap: 16 }}>
      <Text font_size={48} bold>Hello, paper</Text>
      <Checkbox checked={done} label="Ship it" onTap={() => setDone(!done)} />
    </View>
  );
}
```

Styles use a flexbox subset with snake_case keys (`flex_direction`, `justify_content`,
`align_items`, `gap`, `padding`, `margin`, `width`, `height`, `position`, insets). Colors are
grays 0–255. See `docs/ARCHITECTURE.md` for the full prop list.

## License

MIT.
