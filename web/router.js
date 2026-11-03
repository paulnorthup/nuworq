// Where the person is (#602): the address says the page and the open item; route() sets the state from it and
// draws, go() moves there. Opening an item or a project fetches it ahead as the pointer rests on its link.
import { held, paintInTwo } from './switching.js';
import { S, setState, putIn, removeFrom, PAGE } from './store.js';
import { remember } from './prefs.js';
import { $, api, closeModal, refresh, render } from './ui.js';
import { z } from './views/parts.js';

export function route() {
  if (!$('#modal').hidden) closeModal(); // a dialog belongs to the page it was opened on (#155)
  setState({ railMenu: false, analytics: location.hash.startsWith('#/analytics') });
  const m = location.hash.match(/^#\/p\/([^/]+)(?:\/(\d+))?/);
  const slug = m ? decodeURIComponent(m[1]) : null;
  const ref = m?.[2] ? `#${m[2]}` : null;
  // Arriving from Get started's "+ repo" opens this project's repository form, focused.
  const linking = !!slug && S.linkRepo === slug;
  const arrive = slug && S.onArrive?.slug === slug ? S.onArrive.run : null;
  const moved = slug !== S.slug;
  if (moved) {
    setState({ stage: null, addWork: false, editMission: false, addRemote: linking, pages: { all: PAGE.all, agents: PAGE.agents } });
    // Another project (#503): the last view seen for it this visit, else nothing until the shell's view arrives.
    setState({ missing: null, loading: slug, view: slug ? held(slug, S)?.view ?? null : S.view });
  }
  setState({ linkRepo: null, onArrive: null, slug });
  if (ref !== S.itemRef) setState({ itemRef: ref, item: prefetched(slug, ref), deep: z() >= 2, editItem: false, editPre: false });
  if (ref) remember(slug, ref);
  // An item opens on this frame: from what was fetched as the pointer rested on it, else as a placeholder.
  if (moved && slug && !S.analytics) {
    // Its header and pulse in the first frame, the whole page in a task after it (#637): a refresh that answers at
    // once (a view fetched ahead) waits for that too, so it never builds the big page before the header paints.
    setState({ shellOnly: slug });
    // Nothing of the page it leaves is kept, so it goes first: diffing a big project's page into the small shell
    // would cost the first frame what the shell saves it.
    paintInTwo(() => { $('#main').replaceChildren(); render({ force: true, also: ['main'] }); }, () => {
      if (S.shellOnly !== slug) return;
      setState({ shellOnly: null });
      if (S.slug === slug) render({ force: true });
    });
  } else if (ref && S.view?.project.slug === slug) render({ force: true });
  refresh({ force: true, fresh: !moved, list: false }).then(() => { if (linking) $('#remote-in')?.focus(); arrive?.(); });
}
// Opening an item (#393): fetched when the pointer rests on its link, or as a finger lands on it, so it opens
// without a wait. Kept a few seconds; the open refreshes it from the hub all the same.
const PREFETCH_FOR = 15_000;
export function prefetch(slug, ref) {
  const key = `${slug} ${ref}`;
  const had = S.prefetched.get(key);
  if (!slug || !ref || (had && Date.now() - had.at < PREFETCH_FOR)) return;
  const entry = { at: Date.now(), item: null };
  putIn('prefetched', key, entry);
  api(`/api/p/${encodeURIComponent(slug)}/items/${encodeURIComponent(ref.replace('#', ''))}`)
    .then((it) => { entry.item = it; })
    .catch(() => removeFrom('prefetched', key));
}
function prefetched(slug, ref) {
  const had = ref && S.prefetched.get(`${slug} ${ref}`);
  return had?.item && Date.now() - had.at < PREFETCH_FOR ? had.item : null;
}
export const openTarget = (e) => {
  const el = e.target.closest?.('[data-action="open"][data-item]');
  return el && { slug: el.closest('[data-project]')?.dataset.project ?? S.slug, ref: el.dataset.item };
};
// A link to a project (the rail's, a launcher row): its view is fetched the same way, so it opens filled in (#503).
export const projectTarget = (e) => {
  const m = e.target.closest?.('a[href^="#/p/"]')?.getAttribute('href').match(/^#\/p\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
};
export const go = (slug, ref) => { location.hash = slug ? `#/p/${encodeURIComponent(slug)}${ref ? '/' + ref.replace('#', '') : ''}` : '#/'; };
