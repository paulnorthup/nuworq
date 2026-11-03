// A group's map (#215): a person opens it to see what's left and what it waits on, so the parts still open come
// first, in the order `next` offers them (landing, then verifying, ready and proposed, each by priority, then
// number), then the open parts no one is offered (being worked on, waiting, outside). The done ones are
// reference: one line folds them. Dropped ones leave the map (#442): only "Show dropped" at 30m brings them back.
// Pure, so the page and the tests share it.
const OFFERED = { landing: 0, verifying: 1, ready: 2, proposed: 3, active: 4, waiting: 5, outside: 6 };
const PRIORITY = { now: 0, soon: 1, later: 2 };
const seq = (n) => Number(String(n.item).replace('#', ''));

// children: a map node's children ({ item, stage, priority, … }). open: what's left, in order. folded: the done
// ones, by number. label: what the fold line says, e.g. "26 done". dropped: the dropped ones, by number. With
// nothing open, open is every done child as it was (by number) and nothing folds.
export function mapParts(children) {
  const dropped = children.filter((n) => n.stage === 'dropped');
  const kept = children.filter((n) => n.stage !== 'dropped');
  const folded = kept.filter((n) => n.stage === 'done');
  if (folded.length === kept.length) return { open: kept, folded: [], label: '', dropped };
  const open = kept.filter((n) => n.stage !== 'done').sort((a, b) => (OFFERED[a.stage] ?? 9) - (OFFERED[b.stage] ?? 9)
    || (PRIORITY[a.priority] ?? 9) - (PRIORITY[b.priority] ?? 9) || seq(a) - seq(b));
  return { open, folded, label: folded.length ? `${folded.length} done` : '', dropped };
}
