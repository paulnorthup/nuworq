// What just shipped (#130): a tiny "new" tag on a feature for 7 days after it ships, until you've used it.
// Shipping a visible UI feature? Add its key here with today's date, and data-new="<key>" on its element.
export const NEW = {
  home: '2026-10-29', // #126: the home, everything that needs you across projects (the rail's Projects link)
  'github-app-status': '2026-10-29', // #94: where the hub's GitHub App stands, in Connect an agent
  'step-checklist': '2026-10-30', // #162: a question's steps as a checklist on its Needs you card
  'dependabot-alerts': '2026-10-30', // #180: whether Dependabot alerts come in, in a project's GitHub dialog
  analytics: '2026-10-31', // #239: the workspace's analytics, for its owners (the home's Analytics button)
  milestones: '2026-10-31', // #269: groups are called milestones (the project's 30-second Milestones section)
  shortcuts: '2026-10-31', // #274: every keyboard shortcut, on ? (the rail's "? Shortcuts" hint)
  'group-progress': '2026-10-31', // #270: a bar beside each milestone's state, how far along it is (the first line's)
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

// Tag (or untag) every [data-new] element under root.
export function markNew(root, { now = Date.now(), store } = {}) {
  const seen = seenNew(store);
  for (const el of root.querySelectorAll('[data-new]')) el.classList.toggle('is-new', isNew(el.dataset.new, { now, seen }));
}
