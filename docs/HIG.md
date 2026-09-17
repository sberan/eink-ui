# e-ink interface guidelines

Rules for anyone, human or agent, writing components or apps for eink-ui. The panel is a
1072×1448 8-bit grayscale e-ink display refreshed in two ways: a fast partial update (DU, about
260 ms, black and white only, leaves faint ghosts) for most changes, and a full flash (GC16, about
half a second, every level of grey, the whole panel inverts) now and then to clear ghosting. Most
of what looks fine on an LCD looks bad here. A test (`js/test/hig.test.ts`) enforces the rules
that can be checked mechanically.

## Do not

1. **No grey text.** Text is black on white, always. A partial update cannot draw grey; it
   thresholds it into speckle, and a full flash renders grey faithfully but softly. Hierarchy comes
   from size, weight, spacing and borders, never from lightness. Done items keep black text; the
   filled box says done.
2. **No grey fills for meaning.** A selection, a pressed key, a highlighted cell is inverted
   (black with white text) or given a thick border. A light grey background disappears in a
   partial update.
3. **No transient text.** Nothing that reads "syncing…", "saving", "loading" or a counter that
   changes every few seconds. Every change of text is a visible repaint, and a state that flips
   back within seconds is a flicker. Show only states that last: an error, a mode, a file name.
   Show the sleep notice; do not show progress.
4. **No animation, spinners, blinking or hover.** Feedback for a tap is one inversion held for a
   moment, then the result. Nothing moves on its own.
5. **No layout shifts from state.** A status change must not move other content: give status
   text a fixed height and width, keep rows a fixed height whether checked or not, and never
   reflow the page because a small thing changed. Shifting content repaints everything below it.
6. **No thin lines, no small type.** Borders and rules are 2 px or more, body text 28 px or more,
   captions 24 px or more, and touch targets 44 px or taller. The panel is 300 dpi and the finger
   is not.
7. **No scrolling.** Page instead. A list longer than the panel is paged with the buttons, and
   anything that must stay reachable (a keyboard, an action) is an overlay pinned to an edge, not
   a flow item after the list.
8. **No images with gradients or photographs** unless dithered on purpose. Icons are geometry
   drawn with boxes, or glyphs the serif font has.
9. **No frequent timers.** A clock ticks once a minute at most; battery every minute is plenty.
   The device sleeps after a few minutes anyway, and a timer repaint is a partial update someone
   can see.
10. **No full-panel flashes on purpose.** The core schedules them. If a screen needs one (a
    whole new page), request it once, never per interaction.

## Do

- Black text, white ground, 2 px borders, generous spacing.
- Change the smallest region you can. One checkbox tap should repaint that row only; the damage
  tracker reports how much was repainted and the simulator shows it.
- Prefer geometry to glyphs for status: the battery is a box with a fill, not a symbol.
- Keep text widths stable: a clock in `9:41` form keeps its width; a percentage is right-aligned.
- Make every interactive element at least 44 px tall and give it a border or fill, so it looks
  tappable without colour.
- Test in the simulator with the e-ink timing on, and on the device before calling it done. The
  simulator is honest about partial versus full updates, not about ghosting.
