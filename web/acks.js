// Who acknowledged a steer (#211). A broadcast steer collects an ack from every one-off worker, so past a
// handful it reads as one line: the count, the latest few, and the rest behind a tap. Active agents who
// haven't acknowledged are what Paul might act on: always listed in full, before the count.
// Pure, so the page and the tests share it.
export const ACKS_INLINE = 5;
const LATEST = 3;

// acks: [{ agent, response, at }]; missing: names of active agents who haven't acked.
// open: the full list shows; responses: each ack's response shows inline (otherwise in its title), one row each,
// since a response runs to a few hundred characters. Names alone sit in dense columns.
// key: the toggle's key (data-action="toggle").
export function ackList({ acks, missing = [], key, open = false, responses = false, empty = 'not seen yet' }, { esc }) {
  const chip = (a) => `<span class="ack" title="${esc(a.response)}">${esc(a.agent)}${responses && a.response ? `: ${esc(a.response)}` : ''}</span>`;
  const unacked = missing.map((n) => `<span class="unacked">${esc(n)} hasn't acknowledged</span>`).join('');
  if (acks.length <= ACKS_INLINE) return acks.map(chip).join('') + unacked + (!acks.length && !missing.length ? `<span class="unacked">${empty}</span>` : '');
  const latest = [...acks].sort((a, b) => b.at - a.at);
  const rest = acks.length - LATEST;
  const line = `<span class="ack-sum"><span class="ack">${acks.length} agents acknowledged</span> · latest: ${latest.slice(0, LATEST).map((a) => esc(a.agent)).join(', ')}
    <button class="link more-acks" data-action="toggle" data-key="${esc(key)}" aria-expanded="${open}">${open ? 'Show fewer' : `+${rest} more`}</button></span>`;
  return unacked + line + (open ? `<ul class="ack-all${responses ? ' rows' : ''}">${latest.map((a) => `<li>${chip(a)}</li>`).join('')}</ul>` : '');
}
