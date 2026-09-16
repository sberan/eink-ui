import type { TodoList } from './schema.js';

/** Bundled fallback list (21 items) used when the host supplies nothing valid. */
export const SAMPLE: TodoList = {
  date: '2026-09-15',
  sections: [
    {
      title: 'Morning',
      items: [
        { id: 'm1', text: 'Coffee and read the overnight alerts', done: true },
        { id: 'm2', text: 'Stand-up notes for the inference team', done: true },
        { id: 'm3', text: 'Review the eink-core damage diff PR', done: false },
        { id: 'm4', text: 'Reply to the Kindle jailbreak thread', done: false },
        { id: 'm5', text: 'Water the plants on the back step', done: false },
      ],
    },
    {
      title: 'Deep work',
      items: [
        { id: 'd1', text: 'Taffy measure cache for text nodes', done: false },
        { id: 'd2', text: 'FBInk raw blit per damage rect', done: false },
        { id: 'd3', text: 'QuickJS heap budget for the React bundle', done: false },
        { id: 'd4', text: 'Ghosting policy: full flash every 8 partials', done: true },
        { id: 'd5', text: 'Crossword clue index from the puzzle file', done: false },
        { id: 'd6', text: 'Battery drain measurement overnight', done: false },
      ],
    },
    {
      title: 'Errands',
      items: [
        { id: 'e1', text: 'Pick up the USB serial adapter', done: false },
        { id: 'e2', text: 'Post the return label', done: true },
        { id: 'e3', text: 'Groceries: oats, olives, tinned fish', done: false },
        { id: 'e4', text: 'Bike tyre pressure', done: false },
      ],
    },
    {
      title: 'Evening',
      items: [
        { id: 'v1', text: 'Call Mum', done: false },
        { id: 'v2', text: 'Thirty pages of the Vonnegut', done: false },
        { id: 'v3', text: 'Stretch, twenty minutes', done: false },
        { id: 'v4', text: 'Plan tomorrow in three lines', done: false },
        { id: 'v5', text: 'Charge the Voyage', done: true },
        { id: 'v6', text: 'Lights out by eleven', done: false },
      ],
    },
  ],
};
