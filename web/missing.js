// A link to a project that isn't here (#143): archived (restore it from here), or renamed or never there.
// Pure, so the page and the tests share it.
export function missingProject({ slug, archived }, { esc }) {
  return `<div class="zero missing"><span class="check">?</span><div>${archived
    ? `<b>${esc(archived.name)}</b> is archived: its items and history are kept. <button class="btn small" data-action="restore-project" data-slug="${esc(slug)}">Restore it</button>`
    : `No project "${esc(slug)}": it may have been archived, renamed or never existed.`}
    <div class="missing-links"><a href="#/">Home</a> · <button class="link" data-action="archived">Archived projects</button></div></div></div>`;
}
