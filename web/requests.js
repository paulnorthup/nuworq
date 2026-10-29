// The hub owners' list of early-access requests: approve (and copy the link to send) or decline.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = (t) => (t ? new Date(t).toLocaleString() : '');

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error + (j.hint ? ` — ${j.hint}` : ''));
  return j;
}

async function load() {
  const list = $('#list');
  try {
    const { requests } = await api(`/api/early-access?state=${encodeURIComponent($('#state').value)}`);
    list.innerHTML = requests.length ? requests.map((r) => `<div class="row-item">
      <div class="body"><div class="h">${esc(r.email)}${r.github ? ` · <a href="https://github.com/${esc(r.github)}" target="_blank" rel="noopener">@${esc(r.github)}</a>` : ''}</div>
        <div class="s">${esc(r.building) || '<span class="faint">(no note)</span>'}</div>
        <div class="s faint">asked ${esc(when(r.updated_at))}${r.decided_at ? ` · ${esc(r.state)} by ${esc(r.decided_by)} ${esc(when(r.decided_at))}` : ''}</div>
        <div class="s" id="link-${r.id}"></div></div>
      ${r.state === 'new' ? `<button class="btn primary small" data-id="${r.id}" data-approve="1">Approve</button><button class="btn ghost small" data-id="${r.id}">Decline</button>` : ''}
    </div>`).join('') : '<p class="faint">Nothing here.</p>';
  } catch (e) { list.innerHTML = `<p class="faint">${esc(e.message)}</p>`; }
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  try {
    const r = await api('/api/early-access/decide', { id: Number(b.dataset.id), approve: !!b.dataset.approve });
    if (r.link) {
      await load();
      const box = document.getElementById(`link-${b.dataset.id}`) ?? $('#list');
      box.insertAdjacentHTML('afterbegin', `<p>Send them this link (shown once): <code>${esc(r.link)}</code></p>`);
      navigator.clipboard?.writeText(r.link).catch(() => {});
      return;
    }
    load();
  } catch (err) { alert(err.message); }
});
$('#state').addEventListener('change', load);
load();
