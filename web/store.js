// The app's state (#600): every field declared here with its default, and changed only through the setters below
// (test/store.test.js fails on a direct S.x = anywhere else). Each field names the regions a change to it redraws
// (rail, main, drawer); nothing reads that yet beyond the test that pins it. It's the base for redrawing region by
// region (#526). Read S freely.

export const PAGE = { all: 100, agents: 50 }; // a page of All work and of earlier agents (src/insight.js PAGE)

const R = 'rail', M = 'main', D = 'drawer';
// name: [default (a function makes a fresh one per store), regions it affects]
export const FIELDS = {
  // where the person is
  projects: [() => [], [R, M]],
  slug: [null, [R, M, D]],
  view: [null, [M, D]],
  views: [() => new Map(), []], // slug → the last view seen for it this visit, drawn at once when it opens again (#503)
  loading: [null, [M]], // the project whose view is on its way: its page is marked as updating
  missing: [null, [M]], // a project that isn't there: { slug, archived } (#143)
  listStale: [true, []], // the project list may have changed since it was fetched: a live change says so (#503)
  pages: [() => ({ all: PAGE.all, agents: PAGE.agents }), [M]], // how much of All work and of earlier agents the page asks for (#501)
  zoom: ['30s', [M, D]],
  home: [null, [M]],
  homeFresh: [null, []], // boot's /api/home answer, for the first refresh to use (#599)
  gs: [null, [M]], // Get started
  gsFresh: [false, []], // boot just asked for Get started (#599)
  // the workspace's analytics (#239)
  analytics: [false, [R, M]],
  period: ['14d', [M]],
  outcomes: [null, [M]],
  // who is looking, and the hub
  me: [null, [R, M, D]],
  person: [null, [M]],
  info: [null, [R, D]],
  billing: [null, [R]],
  checkoutDone: [false, []], // just back from Stripe Checkout
  feedback: [null, [R]],
  feedbackCtx: [null, []], // what a feedback message attaches: the page, the version, the browser
  notifyPerson: [null, []], // who "only what needs me" means
  offline: [null, []], // since when the hub has been out of reach (#142); its bar is drawn on its own
  // the open item
  itemRef: [null, [D]],
  item: [null, [D]],
  deep: [false, [D]],
  editItem: [false, [D]],
  editPre: [false, [D]],
  prefetched: [() => new Map(), []], // ref → { at, item } fetched when the pointer rested on it (#393)
  // what the person has open, picked or typed
  open: [() => new Set(), [M, D]],
  reveal: [() => new Set(), [M, D]],
  drafts: [() => ({}), [M, D]],
  composeKind: ['steer', [M]],
  stage: [null, [M]],
  addWork: [false, [M]],
  addMore: [false, [M]],
  addRemote: [false, [M]],
  linkRepo: [null, []], // a project whose repository form opens on arrival (Get started's "+ repo")
  editMission: [false, [M]],
  feedAll: [false, [M]],
  onlyFeedback: [false, [M]],
  railMenu: [false, [R]],
  orgOpen: [false, [R]],
  actSlug: [null, []], // on the home, the project of the card clicked
  // bookkeeping
  pending: [false, []], // a redraw waits until the person stops typing or scrolling
  sending: [0, []], // actions on their way to the hub, already shown (#393)
};

// The regions a change to these fields redraws, in rail, main, drawer order.
export const regionsOf = (...names) => [R, M, D].filter((r) => names.some((n) => FIELDS[n]?.[1].includes(r)));

export function createStore() {
  const S = Object.fromEntries(Object.entries(FIELDS).map(([k, [d]]) => [k, typeof d === 'function' ? d() : d]));
  const known = (k) => { if (!Object.hasOwn(FIELDS, k)) throw new Error(`no state field "${k}": declare it in web/store.js`); };
  const keyed = (k) => { known(k); if (!S[k] || typeof S[k] !== 'object') throw new Error(`"${k}" isn't a collection`); return S[k]; };
  return {
    S,
    // Each setter returns the regions its change affects.
    setState(patch) {
      for (const k of Object.keys(patch)) known(k);
      Object.assign(S, patch);
      return regionsOf(...Object.keys(patch));
    },
    // A Set's key in or out; a Map's or a plain object's key set or removed.
    toggleIn(k, key) { const c = keyed(k); c.has(key) ? c.delete(key) : c.add(key); return regionsOf(k); },
    addTo(k, key) { keyed(k).add(key); return regionsOf(k); },
    putIn(k, key, value) { const c = keyed(k); if (c instanceof Map) c.set(key, value); else c[key] = value; return regionsOf(k); },
    removeFrom(k, ...keys) { const c = keyed(k); for (const key of keys) if (c instanceof Set || c instanceof Map) c.delete(key); else delete c[key]; return regionsOf(k); },
  };
}

export const { S, setState, toggleIn, addTo, putIn, removeFrom } = createStore();
