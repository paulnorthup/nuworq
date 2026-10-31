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
  calibration: '2026-10-31', // #348: analytics' Difficulty or size, whether an item's difficulty foretells its cost
  'model-trials': '2026-10-31', // #348: in Staffing, the share of building jobs that try a cheaper model
  feedback: '2026-10-31', // #295: tell nuworq's developers what got in your way (the rail's Feedback, on hubs that take it)
  'feedback-mine': '2026-10-31', // #297: under the Feedback form, what you sent and what happened to each
  'feedback-autonomy': '2026-10-31', // #296: how far feedback goes on its own (the admin dashboard's Feedback section)
  guide: '2026-10-31', // #383: the getting-started guide at /guide (the rail's Getting started guide)
  'guide-gs': '2026-10-31', // #383: the same guide from Get started's head (each undone step's How? opens its section)
  'ea-sources': '2026-10-31', // #356: on the admin dashboard, how far the people from each early-access source got
  'model-quality': '2026-10-31', // #349: the quality bar routing keeps to, in Staffing
  'model-why': '2026-10-31', // #349: in an item's drawer, which model its job runs on and why
  'model-routing-results': '2026-10-31', // #349: analytics' Model routing, each model's results per kind of job
  releases: '2026-10-31', // #399: Settings → Release per milestone, and Release now
  breaking: '2026-10-31', // #398: an item that breaks someone says who must do what, in its drawer
  'copy-each-command': '2026-10-31', // #379: several commands in a step, each with its own Copy that copies clean
  'live-view': '2026-10-31', // #358: Settings → Anyone can watch, the project's public live page
  'propose-work': '2026-10-31', // #389: propose work from a project's board, one field first, the rest on demand
  'instant-actions': '2026-10-31', // #393: actions show their result on the tap, and go back if the hub refuses (the Autonomy switch)
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
  // A redraw leaves the tags in place (#392): one whose feature is gone, or moved away from it, goes too.
  for (const tag of root.querySelectorAll('.new-tag')) {
    const host = tag.previousElementSibling, key = tag.dataset?.newTag;
    if (!key) continue;
    const el = host?.dataset?.new === key ? host : host?.querySelector?.(`[data-new="${key}"]`);
    if (!el || !isNew(key, { now, seen })) tag.remove();
  }
}
const anchorOf = (key) => `--new-${key.replace(/[^\w-]/g, '-')}`;

// For a redraw that changes only what changed (web/morph.js, #392): the tags stay where they are, and a tagged
// element's new markup gets the class and anchor markNew gave it, so neither is taken off and put back.
export const keepNew = {
  keep: (n) => !!n.classList?.contains('new-tag'),
  adopt(from, to) {
    if (!from.classList?.contains('is-new') || to.getAttribute('data-new') !== from.getAttribute('data-new')) return;
    to.classList.add('is-new');
    const anchor = from.style.getPropertyValue('anchor-name');
    if (anchor) to.style.setProperty('anchor-name', anchor);
  },
};
function newTag(el, key) {
  const anchor = anchorOf(key);
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
