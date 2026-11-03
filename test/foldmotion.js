// The one transition web/style.css allows (#809, the maintainer: "a touch of animation, not long and slow, but just enough to feel
// premium"): a section folding eases its height, its header's gap and its chevron over 150ms. Only these selectors.
export const FOLD = { ms: 150, sel: new Set(['.sec .fold .chev', '.sec.foldable > header', '.sec.foldable > .fold-body', '.sec.folded > .fold-body']) };

// Whether every selector in a rule's selector list is one of the fold's.
export const isFold = (sel) => sel.split(',').every((s) => FOLD.sel.has(s.trim()));
