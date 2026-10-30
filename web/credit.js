// Who built and who verified a finished item, saying only what's on record (#145): no "built by" without a name.
// who: the page's renderer for a name. Pure, so the page and the tests share it.
export const credit = ({ implementer, accepted }, who) =>
  [implementer && `built by ${who(implementer)}`, accepted && `verified by ${who(accepted)}`].filter(Boolean).join(' · ');
