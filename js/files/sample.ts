/** A small repository for hosts without a real one: the simulator, tests and snapshots. */
export const SAMPLE_FILES: Readonly<Record<string, string>> = {
  'days/2026-09-15.md': `# Tuesday, September 15

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
  'days/2026-09-16.md': `# Wednesday, September 16

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
};
