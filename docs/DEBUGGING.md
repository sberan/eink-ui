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

  Without a laptop: press the power button five times within four seconds. The host buzzes once
  and restarts, which refetches `app.js`. (A long hold is not an option: the Kindle's own power
  manager reboots the device after a few seconds.) If the download fails the host runs the cached
  copy and shows the error badge.

## Wireless deploy loop

No USB cable after the first install, and nothing to copy onto the device but the URL: at every
start the host downloads `app.js` from `update_url` in `/mnt/us/todo-app/keys.conf` (default
`https://kindle-todo-one.vercel.app/`; set it with `:url`) and keeps a cached copy for offline
starts. Publish a new bundle wherever that URL points, then restart the host with `:reload`, or
with five presses of the power button. For a tight local loop, point the URL at a directory on
your machine served by any static HTTP server; `kindle/push.sh` does that round trip:

```sh
cd js && ./build.sh && cd ..      # new bundle
kindle/push.sh bundle             # copies js/dist/app.js to the served directory, sends :reload

./build.sh kindle                 # new host binary
kindle/push.sh host               # copies the binary, sends :update
```

The host restarts by re-executing itself, so the input threads, timers and JavaScript state start
clean. A launcher loop on the device restarts the host if it ever exits with an error.

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
