// What just shipped (#130): a tiny "new" tag on a feature for 7 days after it ships, until you've used it.
// Shipping a visible UI feature? Add its key here with today's date, and data-new="<key>" on its element.
export const NEW = {
  'plan-price': '2026-11-03', // #872: Workspace settings say what Pro gives and costs before Upgrade opens Checkout
  'tests-step': '2026-11-03', // #685: Get started's "Tell workers how to test", while a repository has no test a worker may run
  'rail-menus': '2026-11-03', // #824: the rail is only navigation; settings in the workspace menu (its name), help under ? Help
  'fold-sections': '2026-11-03', // #809: click a section's heading on the project page or home to fold it away
  home: '2026-10-29', // #126: the home, everything that needs you across projects (the rail's Home link)
  'github-app-status': '2026-10-29', // #94: where the hub's GitHub App stands, in Connect an agent
  'step-checklist': '2026-10-30', // #162: a question's steps as a checklist on its Needs you card
  'dependabot-alerts': '2026-10-30', // #180: whether Dependabot alerts come in, in a project's GitHub dialog
  'project-settings': '2026-10-30', // #213: a project's settings in one dialog, from the header's Settings button
  analytics: '2026-10-31', // #239: the workspace's analytics, for its owners (the home's Analytics button)
  milestones: '2026-10-31', // #269: groups are called milestones (the project's 30-second Milestones section)
  shortcuts: '2026-10-31', // #274: every keyboard shortcut, on ? (the rail's "? Shortcuts" hint)
  'group-progress': '2026-10-31', // #270: a bar beside each milestone's state, how far along it is (the first line's)
  'phone-menu': '2026-10-31', // #114: on a phone, the rail's actions (+ Project, Notifications…) behind the top bar's Menu
  launcher: '2026-10-31', // #290: ⌘K, or the rail's Search, opens the quick launcher
  'model-routing': '2026-10-31', // #347: cheaper models for rote jobs, a switch and the model tiers in Staffing
  calibration: '2026-10-31', // #348: analytics' Difficulty or size, whether an item's difficulty foretells its cost
  'model-trials': '2026-10-31', // #348: in Staffing, the share of building jobs that try a cheaper model
  feedback: '2026-10-31', // #295: tell nuworq's developers what got in your way (the rail's Feedback, on hubs that take it)
  'feedback-mine': '2026-10-31', // #297: under the Feedback form, what you sent and what happened to each
  'feedback-autonomy': '2026-10-31', // #296: how far feedback goes on its own (the admin dashboard's Feedback section)
  guide: '2026-10-31', // #383: the getting-started guide at /guide (the rail's Guide)
  'guide-gs': '2026-10-31', // #383: the same guide from Get started's head (each undone step's How? opens its section)
  'ea-sources': '2026-10-31', // #356: on the admin dashboard, how far the people from each early-access source got
  'model-quality': '2026-10-31', // #349: the quality bar routing keeps to, in Staffing
  'model-why': '2026-10-31', // #349: in an item's drawer, which model its job runs on and why
  'model-routing-results': '2026-10-31', // #349: analytics' Model routing, each model's results per kind of job
  releases: '2026-10-31', // #399: Settings → Release per milestone, and Release now
  breaking: '2026-10-31', // #398: an item that breaks someone says who must do what, in its drawer
  'copy-each-command': '2026-10-31', // #379: several commands in a step, each with its own Copy that copies clean
  'live-view': '2026-10-31', // #358: Settings → Anyone can watch, the project's public live page
  'turns-per-job': '2026-11-02', // #751: analytics' Turns per job, the median turns per kind of job
  'propose-work': '2026-10-31', // #389: propose work from a project's board, one field first, the rest on demand
  'instant-actions': '2026-10-31', // #393: actions show their result on the tap, and go back if the hub refuses (the Autonomy switch)
  'present-agents': '2026-10-31', // #441: the agents here now as counts by role ("2 workers · 1 operator"), each opening to its names
  'finished-milestones': '2026-10-31', // #442: a finished milestone is one line in Recently finished, opening to its parts
  'show-dropped': '2026-10-31', // #442: dropped work leaves the board; All work's "Show dropped" at 30m brings it back
  'always-show': '2026-10-31', // #443: Always show on a field note, so every agent gets it whatever it works on
  'verified-install': '2026-11-01', // #473: Connect an agent's install checks the release's signature before installing it
  'security-reviews': '2026-11-01', // #480: Settings' Security reviews switch: a review before each release, an area each month
  'needs-rank': '2026-11-01', // #506: Needs you most important first, each card with its priority (the section's hint)
  appearance: '2026-11-01', // #485: Match device, Light or Dark, in the rail's footer (behind Menu on a phone)
  'worth-knowing-lines': '2026-11-01', // #497: Worth knowing holds only what you might act on, one line each, with Got it, all
  'show-more': '2026-11-01', // #501: at 30m, All work and earlier agents come a page at a time, with Show more for the next
  'setup-that-works': '2026-11-01', // #489: Connect an agent leads with the setup that works: workers, an operator, a shaper
  'agents-told': '2026-11-01', // #550: an item's "Agents told each other", the operators' and the hub's steers, out of Your steering
  'memory-distilled': '2026-11-01', // #552: Steering & memory's Direction today, gists and one-tap recommendations
  'setup-folded': '2026-11-01', // #644: Connect an agent shows one block to copy; what connect sets up is folded beneath it
  'retire-in-menu': '2026-11-02', // #651: Retire shows where it's recommended; on other decisions and notes it's behind the row's ⋯
  'question-numbers': '2026-11-02', // #710: each question shows its number (Q207), and ⌘K finds it by q207 or "question 207"
  'operator-question': '2026-11-02', // #712: with no operator connected, its questions are yours: steps to tick and an answer, and How to start an operator
  'one-name': '2026-11-02', // #708: one name per step of getting going: + Project, Home, Guide, Connect an agent, Staff it with nuworq run (the rail's + Project)
  'feedback-groups': '2026-11-02', // #688: the admin dashboard's feedback in groups: what covers each, a suggested call, one tap, Undo
  'feedback-waiting': '2026-11-02', // #688: for the hub's owners, the home's line of feedback waiting, opening the groups
  'milestones-waiting': '2026-11-02', // #746: milestones that only wait step out of the list behind one quiet line; Stuck means something must change
  'default-tiers': '2026-11-02', // #723: Staffing's Claude models say the default tiers are in use, and when trials can't run
  'worker-commands': '2026-11-02', // #768: Settings' Worker commands: workers run the project's checks, and the commands a person adds
  'stall-causes': '2026-11-02', // #754: analytics' Why work stalled, stalled jobs by cause (exited, timeout, budget, went quiet…)
  'spend-alerts': '2026-11-02', // #767: Needs you at 80% of the daily budget (Raise budget, Pause runners) and for a worker past $50 or an hour (Stop it)
  'workspace-delete': '2026-11-02', // #799: Workspace settings → Delete workspace, for its owners
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

// A tag says "this is new" only while it's rare (#721): a screen shows at most MOST, the most recently shipped
// first, and the rest wait until those are used, dismissed or expire. With a dialog open, the dialog is the screen.
const MOST = 3;
const SCREEN = '#modal:not([hidden])';
const order = Object.keys(NEW); // listed in the order they shipped, so on one day a later key is newer
const newness = (key) => Date.parse(NEW[key]) + order.indexOf(key);
// A feature that isn't drawn (the phone's Menu on a desktop, the rail's foot behind a closed Menu, a closed fold)
// takes no place, so nobody meets a tag they can't see.
// checkVisibility sees inside a closed fold too, where the box still has rects.
const isDrawn = (el) => el.checkVisibility ? el.checkVisibility() : !el.getClientRects || el.getClientRects().length > 0;
export function onScreen(doc, { now = Date.now(), seen = [] } = {}) {
  const screen = doc.querySelector?.(SCREEN) ?? doc;
  const fresh = [...screen.querySelectorAll('[data-new]')].filter((el) => isNew(el.dataset.new, { now, seen }) && isDrawn(el));
  const keys = new Set(), shown = [];
  for (const el of fresh.sort((a, b) => newness(b.dataset.new) - newness(a.dataset.new))) {
    if (keys.has(el.dataset.new) || keys.size >= MOST) continue;
    keys.add(el.dataset.new);
    shown.push(el);
  }
  return shown;
}

// Tag (or untag) the [data-new] elements on the screen root is part of: which ones get a tag depends on the whole
// screen, not only the region just redrawn. The tag is a button of its own (#314), so tapping it can dismiss it:
// it can't sit inside the feature's button or link, so it goes right after that, and CSS anchors it just above
// the tagged element's corner, clear of its text.
const INTERACTIVE = 'a, button, label, summary, select';
// After a summary, the tag would be inside its fold, hidden while it's closed: it goes after the whole fold.
const hostOf = (el) => { const h = el.closest(INTERACTIVE) ?? el; return h.tagName === 'SUMMARY' ? h.closest('details') ?? h : h; };
// Whether a feature is drawn can change with a breakpoint or a fold, and so which ones get the tags: each new
// feature is watched, and a change picks the screen's tags again.
const watched = new WeakSet();
const drawn = globalThis.ResizeObserver && new ResizeObserver((entries) => {
  for (const { target } of entries) if (!target.isConnected) { drawn.unobserve(target); watched.delete(target); }
  markNew(document);
});
export function markNew(root, { now = Date.now(), store } = {}) {
  const doc = root.ownerDocument ?? root, seen = seenNew(store), shown = onScreen(doc, { now, seen });
  for (const el of doc.querySelectorAll('[data-new]')) {
    const key = el.dataset.new, on = shown.includes(el);
    if (drawn && !watched.has(el) && isNew(key, { now, seen })) { watched.add(el); drawn.observe(el); }
    el.classList.toggle('is-new', on);
    const host = hostOf(el), next = host.nextElementSibling;
    const tag = next?.dataset?.newTag === key ? next : null;
    if (on && !tag) host.after(newTag(el, key));
    if (!on && tag) tag.remove();
  }
  // A redraw leaves the tags in place (#392): one whose feature is gone, moved away from it, or no longer among
  // the screen's few goes too.
  for (const tag of doc.querySelectorAll('.new-tag')) {
    const host = tag.previousElementSibling, key = tag.dataset?.newTag;
    if (!key) continue;
    const el = host?.dataset?.new === key ? host : host?.querySelector?.(`[data-new="${key}"]`);
    if (!el || !shown.includes(el)) tag.remove();
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
