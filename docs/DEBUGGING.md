# Remote debugging and wireless updates

The Kindle host (`eink-host`) opens a plain TCP port, **2323**, on the device's Wi-Fi address.
Anything that can open a socket is a debugger: `nc`, `telnet`, or a two-line script.

```sh
kindle/debug.sh            # = nc <kindle-ip> 2323 (set KINDLE_IP or pass the address)
```

What you get on connect:

- **Live log.** Every line the host logs streams to you as it happens: taps with the node they
  resolved to, key presses, powerd events, JavaScript `console.log`, `__eink.log(...)` from the app,
  and errors (prefixed `ERROR:`).
- **A JavaScript REPL inside the running app.** Type an expression, press Enter, and it is evaluated
  in the app's QuickJS context on the main loop, with the result JSON-printed back:

  ```
  __eink.hit(500, 400)              => 28
  JSON.stringify(Object.keys(globalThis)).length
  __eink.request_full(); __eink.commit()
  ```

  Because evaluation happens on the same loop that serves input, you can inspect or mutate React
  state through whatever your app exposes on `globalThis`.

- **Host commands.** Lines starting with `:` are handled by the host itself:

  | command | effect |
  |---|---|
  | `:reload` | restart; every start downloads `app.js` from the update URL (cached copy if offline) |
  | `:update` | download a new `eink-host` binary, install it, restart |
  | `:restart` | restart with the files already on the device |
  | `:exit` | hand the screen back to the stock Kindle UI |
  | `:battery` | charge level and charger state |
  | `:url https://host/dir/` | set the update URL (`:url` alone shows it) |
  | `:repo git@host:owner/repo.git` | set the git repository the app reads and writes (`:repo` alone shows it and whether git and dropbear are installed) |
  | `:sshkey` | the device's deploy key (generated on first use); add it to the repository with write access |

  Without a laptop: press the power button five times within four seconds. The host buzzes once
  and restarts, which refetches `app.js`. (A long hold is not an option: the Kindle's own power
  manager reboots the device after a few seconds.) If the download fails the host runs the cached
  copy and shows the error badge.

## Wireless deploy loop

Nothing is copied onto the device after the first install, only pulled. `update_url` in
`/mnt/us/todo-app/keys.conf` names a store: a `manifest.json` listing files with their sha256,
next to the files themselves. The host syncs that store into `/mnt/us/todo-app` at every
start, on every timed wake, every five minutes while awake, on `:sync`, and on five presses of
the power button; a changed `app.js` or `eink-host` restarts the host. Files that leave the
manifest are deleted. A store without a manifest still works: `app.js` alone is fetched.

The store is written by [eink-mcp](https://github.com/sberan/eink-mcp), an MCP server whose
`put_file` tool uploads into a Vercel Blob store and rewrites the manifest, so any agent with
that MCP server can push files to the device:

```
put_file path=app.js content=<bundle>            # next sync restarts with the new bundle
put_file_from_url path=eink-host url=<CI build>  # host binary from anywhere
status                                            # the base URL to set with :url
```

For a tight local loop without the cloud, point `update_url` at a directory on your machine
served by any static HTTP server (no manifest needed) and use `kindle/push.sh`, or run
"SSH On" on the device and `scp` straight into `/mnt/us/todo-app`.

Over the debug port, `:sync` pulls the store now and reports what changed, `:url` shows or sets
the store, `:reload` restarts (which syncs first), and `:update` fetches `eink-host` by name.

## The synced repository

Besides the store, the host can keep a git checkout under `/var/local/eink-ui/repo` and expose
it to the app as files: `__eink.read_file`, `write_file`, `list_files`, `sync_state`, `sync`,
with `files` and `sync` events when a pull lands. A write is committed at once and pushed a few
seconds later; pulls happen at start, on every wake, every five minutes while awake, and on
`:sync`. Transport is SSH through the bundled dropbear client with a deploy key made on the
device. Setup, all wireless:

1. Put `bin/git` and `bin/dropbearmulti` (built by `build.sh`, or from `third_party/`) into the
   store; the host installs them into `/var/local/eink-ui/bin`.
2. `:repo git@github.com:you/notes.git`, then `:sshkey`, and add that key to the repository as a
   deploy key with write access.
3. `:sync`. Markdown files under `days/` make the reader app take over from the JSON todo list.

A conflict on pull (an agent changed the line you just ticked) keeps the remote version and
drops the device's commit; the next tap redoes it. If `dist/app.js` or `bin/eink-host` is
committed to the repository, it replaces the store's copy and restarts the host.

## The error badge

If anything goes wrong at runtime, a small black badge with a white `!` appears in the top-right
corner of the panel and stays there until the next `:reload` or until the app calls
`__eink.clear_error()`. Triggers:

- a JavaScript exception in an event listener, a timer, or the bundle itself,
- `__eink.error("message")` called by the app (the todo app uses it for failed fetches),
- a panic inside the host (caught, logged, and the loop continues),
- a framebuffer refresh the kernel rejected.

The message behind the badge is always in the log, so `kindle/debug.sh` shows the cause.

## Reading logs without a network

`/mnt/us/todo-app/host.log` is the same stream, readable over USB. While the Kindle is in USB
drive mode that partition is unmounted on the device, so lines written during that window go to
`/var/tmp/todo-app/host.log` and are appended back after the cable is unplugged.

## Security note

The debug port has no authentication. It is meant for a home network; do not expose the Kindle
to an untrusted LAN with the host running, or bind it elsewhere in `debug_server()` first.
