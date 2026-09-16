# eink-ui architecture

Three layers, one scene model.

## eink-core (Rust, native + wasm32)
Retained scene tree. Nodes have an id, a kind (`Box`, `Text`), a Taffy flexbox style, and paint
props (background, border, color, font size/weight, text). Text nodes measure themselves with fontdue.
`Scene::commit()` runs layout, diffs against the last committed frame, rasterizes only the union of
old and new rects of changed nodes into an 8-bit grayscale framebuffer, and returns the list of damage
rects. Hit testing maps a (x, y) to the deepest node with an `id` that has `hit: true`.

Public API (mirrored 1:1 by the wasm and QuickJS bindings, all ids are u32):
- `create(kind: "box"|"text") -> id`
- `set_props(id, json)` – partial update; any of: style (Taffy subset), bg, border, color, text, font_size, bold, align, hit
- `append(parent, child)`, `insert_before(parent, child, before)`, `remove(parent, child)`
- `set_root(id)`
- `commit() -> [ {x,y,w,h,mode} ]` – mode is "du" (fast B/W partial) or "gc16" (full quality)
- `hit(x, y) -> id | 0`
- `request_full()` – next commit uses a full flash
- framebuffer access: `fb_ptr()/fb_len()` (wasm), region copy for FBInk (native)

## Hosts
- **kindle** (`crates/eink-kindle`, binary `eink-host`): QuickJS runs the React bundle. Globals:
  `__eink.*` (API above plus `log`, `buzz`, a synchronous `fetch`, `charging`, `now`), `__eink.on(cb)`
  for input events `{type:"tap"|"key", id, x, y, key}`, `__eink_exit()`, `setTimeout`/`clearTimeout`,
  `console`. Damage rects are copied into the mmap'ed `/dev/fb0` and refreshed with one
  `MXCFB_SEND_UPDATE` each (DU partial, or a flashing GC16 full). Input from `/dev/input`; on battery
  the process turns Wi-Fi and the frontlight off and suspends to RAM after 3 idle minutes, waking on
  the RTC every 30 minutes or on the power key. The typed contract lives in `js/host/eink.ts`.
- **sim** (`js/sim`): the same renderer in a browser tab against the wasm build (`js/sim/pkg`). It
  opens on a gallery of component stories and the demo apps. Damage rects are drawn to a canvas with
  e-ink timings: DU ≈ 260 ms, GC16 ≈ 450 ms with a black flash, and the region stays "in flight"
  (grey) until the waveform completes. Physical keyboard and mouse map to the same `tap`/`key` events.
  A counter shows how many partials since the last full refresh.

## React (`js/renderer`, TypeScript)
`react-reconciler` host config: `createInstance` → `__eink.create`, `commitUpdate` → `set_props`,
tree ops → `append/insert_before/remove`, `resetAfterCommit` → `commit()` and paint. Legacy (sync) root.
Components (`js/components`): `View`, `Text`, `Button`, `Checkbox`, `Row`, `Column`, `Grid`, `Keyboard`.
Apps (`js/apps`): `todo` (loads the list via the host's `__eink.fetch`, validated by `schema.ts`),
`crossword`. Stories (`js/stories`) feed the simulator's gallery.
