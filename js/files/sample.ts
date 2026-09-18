/** A small repository for hosts without a real one: the simulator, tests and snapshots. */
export const SAMPLE_FILES: Readonly<Record<string, string>> = {
  'data/2026-09-15.md': `# Tuesday, September 15

## Morning
- [x] Coffee and read the overnight alerts
- [x] Stand-up notes for the inference team
- [ ] Review the eink-core damage diff PR
- [ ] Reply to the Kindle jailbreak thread

## Deep work
- [ ] Taffy measure cache for text nodes
- [ ] QuickJS heap budget for the React bundle
- [x] Ghosting policy: full flash every 8 partials

## Evening
- [ ] Call Mum
- [ ] Thirty pages of the Vonnegut
`,
  'data/2026-09-16.md': `# Wednesday, September 16

- [ ] Battery drain measurement overnight
- [ ] Post the return label
- [x] Charge the Voyage

> Sync happens on every wake; a tick here is a commit.
`,
  'notes/readme.md': `# Notes

This folder is a plain git repository. **Bold** and *italic* markers are dropped, [[wikilinks]]
show their text, and anything the panel cannot draw is left out.

1. Headings, paragraphs and lists render.
2. Task lists toggle with a tap.
3. Everything else is ignored.

---

Tap the title to add a task.
`,
  'package.json': `{
  "name": "sample",
  "main": "dist/app.js",
  "eink": {
    "app": { "home": "data/" },
    "display": { "theme": "light", "frontlight": "auto", "dark_lux": 15, "dark_level": 8 },
    "clock": { "tz": "auto" },
    "ssh": { "enabled": true, "users": ["sberan"] },
    "power": { "stages": [
      { "name": "on", "minutes": 10, "functions": ["frontlight", "cpu", "wifi", "sync", "haptics"] },
      { "name": "low power", "minutes": 50, "functions": ["wifi", "sync"] },
      { "name": "sleep", "suspend": true, "wake_every_minutes": 30 }
    ] }
  }
}
`,
};
