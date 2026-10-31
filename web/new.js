// What just shipped (#130): a tiny "new" tag on a feature for 7 days after it ships, until you've used it.
// Shipping a visible UI feature? Add its key here with today's date, and data-new="<key>" on its element.
export const NEW = {
  home: '2026-10-29', // #126: the home, everything that needs you across projects (the rail's Projects link)
  'github-app-status': '2026-10-29', // #94: where the hub's GitHub App stands, in Connect an agent
  'step-checklist': '2026-10-30', // #162: a question's steps as a checklist on its Needs you card
  'dependabot-alerts': '2026-10-30', // #180: whether Dependabot alerts come in, in a project's GitHub dialog
  'project-settings': '2026-10-30', // #213: a project's settings in one dialog, from the header's Settings button
  analytics: '2026-10-31', // #239: the workspace's analytics, for its owners (the home's Analytics button)
  milestones: '2026-10-31', // #269: groups are called milestones (the project's 30-second Milestones section)
  shortcuts: '2026-10-31', // #274: every keyboard shortcut, on ? (the rail's "? Shortcuts" hint)
  'group-progress': '2026-10-31', // #270: a bar beside each milestone's state, how far along it is (the first line's)
  'phone-menu': '2026-10-31', // #114: on a phone, the rail's actions (New project, Notifications…) behind the top bar's Menu
  launcher: '2026-10-31', // #290: ⌘K, or the rail's Search, opens the quick launcher
  'model-routing': '2026-10-31', // #347: cheaper models for rote jobs, a switch and the model tiers in Staffing
  feedback: '2026-10-31', // #295: tell nuworq's developers what got in your way (the rail's Feedback, on hubs that take it)
  'feedback-mine': '2026-10-31', // #297: under the Feedback form, what you sent and what happened to each
  'feedback-autonomy': '2026-10-31', // #296: how far feedback goes on its own (the admin dashboard's Feedback section)
  guide: '2026-10-31', // #383: the getting-started guide at /guide (the rail's Getting started guide, Get started's Guide and How?)
  'ea-sources': '2026-10-31', // #356: on the admin dashboard, how far the people from each early-access source got
  'copy-each-command': '2026-10-31', // #379: several commands in a step, each with its own Copy that copies clean
};

const DAYS = 7;
const KEY = 'nuworq.seen-new';

// Whether a feature still gets its tag: shipped within the last DAYS days, and not yet used by this viewer.
export function isNew(key, { now = Date.now(), shipped = NEW[key], seen = [] } = {}) {
  const at = Date.parse(shipped ?? '');
  return Number.isFinite(at) && now >= at && now < at + DAYS * 864e5 && !seen.includes(key);
}

// The features this viewer has used, kept in the browser. Storage refused (private mode): nothing seen, tags show.
// Even reading localStorage can throw (a sandboxed frame, some private modes), so it's only touched inside try.
export function seenNew(store) {
  try { const s = JSON.parse((store ?? globalThis.localStorage).getItem(KEY) ?? '[]'); return Array.isArray(s) ? s : []; } catch { return []; }
}
export function markSeen(key, store) {
  try { (store ?? globalThis.localStorage).setItem(KEY, JSON.stringify([...new Set([...seenNew(store), key])])); } catch { /* not kept: the tag shows again next time */ }
}

// Tag (or untag) every [data-new] element under root. The tag is a button of its own (#314), so tapping it can
// dismiss it: it can't sit inside the feature's button or link, so it goes right after that, and CSS anchors it
// over the tagged element's corner.
const INTERACTIVE = 'a, button, label, summary, select';
// A feature that isn't drawn (the phone's Menu on a desktop, the rail's foot behind a closed Menu) hides its tag,
// so the keyboard and screen readers never reach a tag nobody can see. Watched, since a breakpoint can change it.
const drawn = globalThis.ResizeObserver && new ResizeObserver((entries) => {
  for (const { target: el } of entries) if (el.newTag) el.newTag.hidden = !el.getClientRects().length;
});
export function markNew(root, { now = Date.now(), store } = {}) {
  const seen = seenNew(store);
  for (const el of root.querySelectorAll('[data-new]')) {
    const key = el.dataset.new, on = isNew(key, { now, seen });
    el.classList.toggle('is-new', on);
    const host = el.closest(INTERACTIVE) ?? el, next = host.nextElementSibling;
    const tag = next?.dataset?.newTag === key ? next : null;
    if (on && !tag) host.after(newTag(el, key));
    if (!on && tag) { tag.remove(); drawn?.unobserve(el); }
  }
}
function newTag(el, key) {
  const anchor = `--new-${key.replace(/[^\w-]/g, '-')}`;
  el.style.setProperty('anchor-name', anchor);
  const tag = el.ownerDocument.createElement('button');
  Object.assign(tag, { type: 'button', className: 'new-tag', title: 'Dismiss', textContent: 'new' });
  tag.dataset.newTag = key;
  tag.setAttribute('aria-label', 'Dismiss new tag');
  tag.style.setProperty('position-anchor', anchor);
  el.newTag = tag;
  drawn?.observe(el);
  return tag;
}

// A click on a tag dismisses it for this viewer and does nothing else: it never reaches the feature's action.
// Run it as a capturing listener on the document, so it comes before every other click handler.
export function dismissNew(e, { root = e.target.ownerDocument, now, store } = {}) {
  const tag = e.target.closest?.('.new-tag');
  if (!tag) return false;
  e.preventDefault();
  e.stopPropagation();
  const host = tag.previousElementSibling, focused = root.activeElement === tag;
  markSeen(tag.dataset.newTag, store);
  markNew(root, { now, store });
  if (focused) host?.focus?.({ preventScroll: true }); // the keyboard stays where it was, not back at the page's top
  return true;
}
