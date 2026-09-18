# Remote debugging and wireless updates

SSH is the only way in (see "SSH into the device" below), and on the device the host answers to
one command, `eink`, over a local socket. From a laptop that is `ssh kindle eink ...`:

```sh
ssh kindle eink log -f                 # the live log: taps with the node they resolved to, keys,
                                       # powerd events, console.log and __eink.log from the app
ssh kindle eink js '__eink.hit(500, 400)'      # JavaScript evaluated inside the running app
ssh kindle eink settings               # the app entry and the settings in force
ssh kindle eink light dark 6 10        # any host command, as listed below without the colon
```

- **The log** is what the host writes to `/mnt/us/todo-app/host.log`; `eink log 50` prints the
  tail, `eink log -f` follows it.
- **The JavaScript REPL** evaluates on the main loop, the same loop that serves input, so you
  can inspect or change React state through whatever the app exposes on `globalThis`:

  ```
  __eink.hit(500, 400)              => 28
  JSON.stringify(Object.keys(globalThis)).length
  __eink.request_full(); __eink.commit()
  ```

- **Host commands.** The table below lists them with the `:` the socket protocol uses; the
  `eink` command takes them without it (`eink tap 60 380`). `npx eink-ui sync` uses
  `ssh kindle eink sync` to make a reachable device pull at once.

  | command | effect |
  |---|---|
  | `:reload` | restart; every start downloads `app.js` from the update URL (cached copy if offline) |
  | `:update` | download a new `eink-host` binary, install it, restart |
  | `:restart` | restart with the files already on the device |
  | `:exit` | hand the screen back to the stock Kindle UI |
  | `:battery` | charge level and charger state |
  | `:url https://host/dir/` | set the update URL (`:url` alone shows it) |
  | `:repo git@host:owner/repo.git` | set the git repository the app reads and writes (`:repo` alone shows it and whether git and dropbear are installed) |
  | `:ssh [refresh\|on\|off\|users a,b]` | SSH server status; refetch the GitHub keys; disable or enable; set the accounts |
  | `:sshkey` | the device's deploy key (generated on first use); add it to the repository with write access |
  | `:sync` | pull the repository and the store now |
  | `:tap x y`, `:key PageUp\|PageDown\|Power` | inject input, for scripted tests over the network |
  | `:slow ms` | log every input event slower than `ms` (default 80; `:slow 1` logs them all) |
  | `:log [n]` | the last `n` lines of host.log |
  | `:conf key=value` | set a keys.conf entry: `repo_url`, `repo_branch`, `github_token`, `update_url` (values are never echoed) |
  | `:settings`, `:set section.key=value` | show the app entry and the settings in force; change one and commit it (see "package.json") |
  | `:ls dir`, `:cat file`, `:strings file` | read-only looks at the device's filesystem |
  | `:theme dark\|light` | pixel inversion |
  | `:light [auto\|off\|dark [level [lux]]\|0-24\|learn 0-24\|nightlight on\|off]` | the frontlight, on the Kindle's own 0 to 24 scale; see "Frontlight" below |

  Without a laptop: press the power button five times within four seconds. The host buzzes once
  and restarts, which refetches `app.js`. (A long hold is not an option: the Kindle's own power
  manager reboots the device after a few seconds.) If the download fails the host runs the cached
  copy and shows the error badge.

## package.json: the app and its settings

The synced repository's `package.json` describes the app the device runs: `main` is the bundle
(`dist/app.js` by default) and the `eink` section holds every setting that is not an address
or a secret, so settings travel with the app and agents change them with a commit. keys.conf on
the device keeps only what is needed to reach the repository: `repo_url`, `repo_branch`,
`github_token`, `update_url`.

```json
{
  "name": "kindle",
  "main": "dist/app.js",
  "eink": {
    "app":     { "home": "data/" },
    "display": { "theme": "light", "frontlight": "auto", "dark_lux": 15, "dark_level": 8 },
    "clock":   { "tz": "auto" },
    "ssh":     { "enabled": true, "users": ["<owner of repo_url>"] },
    "power":   { "stages": [ ...see below... ] }
  }
}
```

| key | meaning |
|---|---|
| `app.*` | the app's own settings; the reader uses `app.home` as the folder it pages through |
| `display.theme` | `light` or `dark` (pixel inversion) |
| `display.frontlight` | `auto` (stock), `off`, `dark`, or a fixed `"0"` to `"24"`; see "Frontlight" |
| `display.dark_lux`, `display.dark_level` | the dark-room mode's threshold and level |
| `clock.tz` | `auto` (detected from the device) or a POSIX zone such as `CST6CDT,M3.2.0,M11.1.0`; needs a restart |
| `ssh.enabled`, `ssh.users` | the SSH server and the GitHub accounts whose keys may log in |
| `power.stages` | the power policy, next section |

**`data/` is the only folder the device writes.** The app's files live there (the reader's
notes), and so does `data/settings.json`: what the debug port's setters (`:light`, `:theme`,
`:ssh`, `:set`) change, merged over the `eink` section key by key and committed like a tick.
The host refuses to write or commit anything else, so the device can never corrupt the app it
runs; `package.json`, `dist/` and `bin/` only ever flow from the repository to the device.

A committed change applies at the next pull (5 minutes awake, every RTC wake asleep, or
`:sync`). `:settings` prints the app entry and the settings in force; `:set display.theme=dark`
writes one key to `data/settings.json` (numbers, booleans and JSON lists parse as JSON,
anything else is a string).

## Power policy

What stays on, and for how long, is the `power.stages` list in the settings. Time without interaction (a tap, a page button, the power button; not SSH or
the debug port, though `:tap` counts) moves the device down the list; any interaction puts it
back at the first stage at once. The default, used when the file or its `power` section is
missing:

```json
{
  "power": {
    "stages": [
      { "name": "on",        "minutes": 10, "functions": ["frontlight", "cpu", "wifi", "sync", "haptics"] },
      { "name": "low power", "minutes": 50, "functions": ["wifi", "sync"] },
      { "name": "sleep",     "suspend": true, "wake_every_minutes": 30 }
    ]
  }
}
```

- `minutes` is how long the stage lasts; the last stage lasts until interaction.
- `functions` names what stays on. Anything not listed is off for the stage:

  | function | on | off |
  |---|---|---|
  | `frontlight` | powerd's auto brightness, or the fixed level from keys.conf | off |
  | `cpu` | the normal governor (ondemand, up to 996 MHz) | pinned to the lowest clock (396 MHz) |
  | `wifi` | radio on: pulls, SSH and the debug port work | radio off: unreachable until interaction |
  | `sync` | the repository and the store are pulled every 5 minutes | no periodic pulls |
  | `haptics` | a buzz on each tick | silent |

- `suspend: true` sleeps the device (everything off) and wakes it every `wake_every_minutes` for
  a pull, which is how a new bundle, host or policy still arrives. On a charger the suspend stage
  is skipped and the device stays in the stage before it.
- A change to the settings takes effect at the next pull. `:power` on the debug port shows the
  stage in force, the time without interaction, and the policy as parsed. Unknown function names
  are logged and ignored; a broken file falls back to the default.

Measured on the Voyage: the frontlight at its auto level in a dim room is 65 to 70 mA, everything
else awake with the light off about 20 mA (roughly 2.5 days of battery), and the CPU clock
matters little at idle.

## Frontlight

The light is driven by the Kindle's own `powerd`, not by the host, so it behaves exactly as the
stock software: auto brightness from the ambient light sensor, a manual level that teaches the
current light bucket, and Nightlight, which dims slowly in the dark. The host only tells powerd
whether the light may be on (the power policy) and which mode applies, through its `flAuto`,
`flIntensity` and `alsNightlightEn` properties.

- `display.frontlight` in the settings: `auto` (default), `off`, `dark`, or a fixed level `0` to
  `24` on the scale of the settings slider. `:light` shows what powerd is doing: mode, level, raw
  PWM, Nightlight, lux.
- `dark` keeps the light off unless the room is really dark: on at `dark_level` (default 8) below
  `dark_lux` (default 15), off again above twice that. `:light dark 6 10` sets both. This is not
  a stock mode; the stock auto brightness always keeps some light on.
- `:light learn 12` with auto on sets the level for the current light and powerd remembers it
  for that bucket, like moving the slider does on the stock UI.
- The stock table as powerd printed it on a Voyage (lux range to raw PWM out of 4095): below 70
  lux 163, 70 to 140 801, 140 to 300 1601, 300 to 1500 1963, 1500 to 4500 1084, above 4500
  (sunlight) 1. Dim in the dark, brightest in a bright room, off outdoors.

## SSH into the device

The host also runs a small SSH server (dropbear, from the same `dropbearmulti` binary as the
git transport), so the standard tools work over Wi-Fi with nothing custom in between:

```sh
ssh root@<kindle-ip>                        # busybox shell as root
ssh root@<kindle-ip> tail -f /mnt/us/todo-app/host.log
ssh root@<kindle-ip> top                    # the host, the sync worker, powerd
scp app.js root@<kindle-ip>:/mnt/us/todo-app/
ssh root@<kindle-ip> cat /dev/fb0 | magick -size 1088x1448 -depth 8 gray:- screen.png
ssh -L 2323:localhost:2323 root@<kindle-ip> # the debug port through the tunnel
```

Logins are by key only; the build has no password authentication at all. The authorized keys
are the ones GitHub publishes for an account at `https://github.com/<user>.keys`, so anyone who
can push to the repository can also log in, and a key removed on GitHub stops working at the
next refresh (at start and every 15 minutes while awake, or `:ssh refresh`). Every listed
account must answer for the file to be rewritten, so a flaky network never revokes anything.

In the settings:

| key | meaning |
|---|---|
| `ssh.enabled: false` | do not run the server (default: true) |
| `ssh.users: ["alice", "bob"]` | GitHub accounts whose keys may log in (default: the owner of `repo_url`) |

The host key and the fetched keys live in `/var/local/eink-ui/ssh/`; the keys are copied into
root's own `~/.ssh` (a tmpfs path on the Kindle, recreated at every start) because dropbear
checks the permissions of every directory above `authorized_keys` up to the home directory.
`:ssh` prints the host key fingerprint for the first connection, and the last lines of the
server's log (`/var/tmp/eink-dropbear.log`) when a login is refused. The firewall rule for
port 22 is added by the host. Keep in mind that the device trusts GitHub's key list: whoever
can add a key to one of those accounts is root on the Kindle, on your Wi-Fi.

## Measuring responsiveness

Every input event slower than the `:slow` threshold logs one line from the host and, when React's
batch took 20 ms or more, one from the renderer:

```
slow tap: 58 ms (js 19 ms, blit 3 ms, epdc 36 ms, 1 rects)
js: react: batch 56 ms = app handler 8 ms + react render/commit 3 ms + host commit 45 ms
```

- `js` is everything QuickJS did for the event minus the paint; `blit` copies damage rects into the
  framebuffer; `epdc` is the panel update ioctl. `full flash` and `git busy` are appended when true.
- `app handler` is the app's own `onTap`/`onKey` code, `react render/commit` is the reconciler, and
  `host commit` is layout plus the paint (the host paints inside `__eink.commit()`, so the pixels
  are on their way before the rest of the batch runs).
- `commit: layout N ms` appears on its own when a layout pass took 10 ms or more, typically a page
  turn onto a file the layout cache has not seen.

Reference numbers on the Voyage: a task tick is 12-13 ms end to end (handler ~1, React ~4,
commit ~5; the first one after a restart can take 60 ms while the sync worker is still busy), a
page turn onto a new file ~60 ms. Two things made ticks slow before: re-rendering the
whole app on every write (fixed by subscribing the page to its own file, see
`js/apps/reader`), and CPU contention from a sync's TLS handshake, which stretched the ioctl from
1 ms to 36 ms (fixed by running the UI thread at nice -5 and every worker at nice 10, `bg()` in
`host.rs`).

To measure from a laptop: `:slow 1`, then `:tap 60 380` on a task row, read the two lines, and
`:slow 80` to restore the default.

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

Besides the store, the host can keep a checkout of a repository under `/mnt/us/eink-ui/repo` and
expose it to the app as files. Two transports, chosen by `repo_url` in `keys.conf`:

- **GitHub over HTTPS** (`repo_url=https://github.com/owner/repo` plus `github_token=`, a
  fine-grained token with contents read and write on that one repository). The device never runs
  git: a pull is one ETag-guarded request while nothing changed, then a tree listing and a
  download per changed file; a write is one `PUT` that GitHub records as a commit. Light on the
  CPU and the battery, and the default.
- **Any git remote over SSH** (`repo_url=git@host:owner/repo.git`), through the bundled static
  git and dropbear client with a deploy key made on the device (`:sshkey`). For hosts that are
  not GitHub, such as a bare repository on your own machine.

The app sees the same files either way: `__eink.read_file`, `write_file`, `list_files`, `sync_state`, `sync`,
with `files` and `sync` events when a pull lands. A write is committed at once and pushed a few
seconds later; pulls happen at start, on every wake, every five minutes while awake, and on
`:sync`. Setup for the SSH transport, all wireless:

1. Put `bin/git` and `bin/dropbearmulti` (built by `build.sh`, or from `third_party/`) into the
   store; the host installs them into `/var/local/eink-ui/bin`.
2. `:repo git@github.com:you/notes.git`, then `:sshkey`, and add that key to the repository as a
   deploy key with write access.
3. `:sync`. Markdown files under `data/` (the folder named by `app.home`) are what the reader
   shows; the device writes nothing outside `data/`.

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
