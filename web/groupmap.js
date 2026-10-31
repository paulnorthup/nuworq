// A group's map (#215): Paul opens it to see what's left and what it waits on, so the parts still open come
// first, in the order `next` offers them (landing, then verifying, ready and proposed, each by priority, then
// number), then the open parts no one is offered (being worked on, waiting, outside). The done and dropped ones
// are reference: one line folds them. Pure, so the page and the tests share it.
const OFFERED = { landing: 0, verifying: 1, ready: 2, proposed: 3, active: 4, waiting: 5, outside: 6 };
const PRIORITY = { now: 0, soon: 1, later: 2 };
const seq = (n) => Number(String(n.item).replace('#', ''));

// children: a map node's children ({ item, stage, priority, … }). open: what's left, in order. folded: the done
// and dropped ones, by number. label: what the fold line says, e.g. "26 done · 2 dropped". With nothing open,
// open is every child as it was (by number) and nothing folds.
export function mapParts(children) {
  const closed = (n) => n.stage === 'done' || n.stage === 'dropped';
  const folded = children.filter(closed);
  if (folded.length === children.length) return { open: children, folded: [], label: '' };
  const open = children.filter((n) => !closed(n)).sort((a, b) => (OFFERED[a.stage] ?? 9) - (OFFERED[b.stage] ?? 9)
    || (PRIORITY[a.priority] ?? 9) - (PRIORITY[b.priority] ?? 9) || seq(a) - seq(b));
  const count = (stage) => folded.filter((n) => n.stage === stage).length;
  const label = [count('done') && `${count('done')} done`, count('dropped') && `${count('dropped')} dropped`].filter(Boolean).join(' · ');
  return { open, folded, label };
}
