// The milestones (#200, #269), the 30-second view's answer to "is what I care about moving, and is anything
// stuck?": one line each, a tap opens its map. Finishing a milestone releases something, so people read
// "milestone"; the code and the API still say group (v.groups, v.ungrouped). Pure, so the page and the tests share it.
import { groupLine } from './groupline.js';

// v: the project view ({ groups, groups_waiting, ungrouped }). Each line is web/groupline.js's: state · bar · count,
// title, reason. Milestones that only wait (#746) step out of the list and its count: one quiet line opens them.
export function milestonesSection(v, { esc, now = Date.now() }) {
  const waiting = v.groups_waiting ?? [];
  if (!v.groups?.length && !waiting.length) return '';
  const line = (g, i) => groupLine({ ...g, reason: reasonAt(g, now) }, { esc, priority: prioritySeg(g.item, g.priority, { esc }), isNew: i === 0 });
  const next = waiting.find((g) => g.until)?.until;
  return `<section class="sec"><header><h2 data-new="milestones">Milestones</h2><span class="count">${v.groups?.length ?? 0}</span><span class="hint">tap one for its map</span></header>
    <div class="groups">${(v.groups ?? []).map(line).join('')}
    ${waiting.length ? `<details class="groups-waiting"><summary data-new="milestones-waiting">${waiting.length} waiting${next ? ` · next: ${esc(next.item)} ${next.time ? `at ${esc(whenText(next, now))}` : `on ${esc(next.text)}`}` : ''}</summary>
      <div class="groups">${waiting.map((g) => line(g, -1)).join('')}</div></details>` : ''}
    ${v.ungrouped ? `<div class="group-none">Not in a milestone (${v.ungrouped})</div>` : ''}</div></section>`;
}

// A wait's time in the device's own zone (#746): "20:50 today", "09:00 tomorrow", "Nov 9, 09:00". A day alone
// stays as written ("Nov 15"): it's the same day wherever you are.
export function whenText(u, now = Date.now()) {
  if (!u.time) return u.text;
  const d = new Date(u.at), day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((day(d) - day(new Date(now))) / 86_400_000);
  return days === 0 ? `${hm} today` : days === 1 ? `${hm} tomorrow` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${hm}`;
}
// The line's reason with its time, if it has one, in the device's zone.
const reasonAt = (g, now) => (g.until?.time ? g.reason.replace(g.until.text, whenText(g.until, now)) : g.reason);

// A milestone's own priority, set in one tap (#198 carries it to everything in it). Reversible, so no dialog.
export const prioritySeg = (item, priority, { esc }) => `<div class="seg g-prio" role="group" aria-label="Priority of ${esc(item)}">${['now', 'soon', 'later'].map((p) =>
  `<button class="${priority === p ? 'on' : ''}" aria-pressed="${priority === p}" data-action="group-priority" data-item="${esc(item)}" data-p="${p}">${p}</button>`).join('')}</div>`;
