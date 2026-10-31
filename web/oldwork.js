// Old work leaves the board (#442). Done work stays 3 days (the hub marks older done work `old`), dropped work
// leaves at once; both stay in search, the quick launcher, analytics and history. Pure, so the page and the
// tests share it.

// all: the view's items. rows: what the board lists. dropped: behind "Show dropped". old: how many finished
// more than 3 days ago.
export function boardWork(all) {
  return {
    rows: all.filter((i) => i.stage !== 'dropped' && !i.old),
    dropped: all.filter((i) => i.stage === 'dropped'),
    old: all.filter((i) => i.old).length,
  };
}
