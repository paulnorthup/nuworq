// The public live view of a project (#358): what agents are doing on it now, read-only, refreshed on its own.
// Its data comes from /api/live/<slug> (src/live.js), which lets out only an allowlist.
const api = location.pathname.replace(/\/live\//, '/api/live/').replace(/\/$/, '');
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (n) => (n == null ? '–' : `$${n.toFixed(2)}`);
const STAGE = { building: 'building', reviewing: 'reviewing', shaping: 'shaping', landing: 'landing' };
const COURT = [['agents', 'Agents working'], ['queue', 'Ready, waiting for an agent'], ['you', 'Waiting on a person'], ['external', 'Waiting outside']];

function render(d) {
  document.title = `Watch agents build ${d.project.name} · nuworq`;
  $('name').textContent = d.project.name;
  $('dot').className = `dot ${d.pulse.state}`;
  $('sentence').textContent = d.pulse.sentence;
  const who = (x) => [x.agent, x.model].filter(Boolean).map(esc).join(' · ');
  const motion = d.motion.length
    ? `<ul>${d.motion.map((m) => `<li><span class="t"><span class="doing">${STAGE[m.stage] ?? esc(m.stage)}</span>${esc(m.item)} ${esc(m.title)}</span><span class="meta">${who(m)} · for ${esc(m.for)}</span></li>`).join('')}</ul>`
    : '<p class="faint">Nothing in motion this minute. Agents pick up the next item as it is ready.</p>';
  const t = d.totals;
  const max = Math.max(1, ...d.flow.throughput);
  const court = COURT.filter(([k]) => d.flow.court[k]);
  const landed = d.landed.length
    ? `<ul>${d.landed.map((l) => `<li><span class="t">${esc(l.item)} ${esc(l.title)}</span><span class="meta">${[who(l), l.ago && `landed ${esc(l.ago)} ago`].filter(Boolean).join(' · ')}</span></li>`).join('')}</ul>`
    : '<p class="faint">Nothing has landed yet.</p>';
  $('body').innerHTML = `
    <section aria-label="In motion"><h2>In motion now</h2>${motion}</section>
    <section aria-label="Totals"><h2>So far${t.since ? ` · since ${new Date(t.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}</h2>
      <div class="totals">
        <div><div class="num">${t.landed}</div><div class="meta">changes landed</div></div>
        <div><div class="num">${t.sent_back}</div><div class="meta">sent back in review</div></div>
        <div><div class="num">${esc(t.median_cycle ?? '–')}</div><div class="meta">median, claim to landed</div></div>
        <div><div class="num">${usd(t.cost_per_landed)}</div><div class="meta">model cost per landed change</div></div>
      </div></section>
    <div class="grid">
      <section aria-label="Flow"><h2>Flow · last ${esc(d.flow.window)}</h2>
        <div class="bar" role="img" aria-label="${court.map(([k, l]) => `${l} ${d.flow.court[k]}%`).join(', ')}">${court.map(([k]) => `<span class="${k}" style="width:${d.flow.court[k]}%"></span>`).join('')}</div>
        <div class="key">${court.map(([k, l]) => `<span><i class="${k}"></i>${l} ${d.flow.court[k]}%</span>`).join('')}</div>
        <div class="days" role="img" aria-label="Changes landed per day, last ${esc(d.flow.window)}">${d.flow.throughput.map((n) => `<span style="height:${Math.round((100 * n) / max)}%" title="${n}"></span>`).join('')}</div>
        <div class="meta">Landed per day</div>
      </section>
      <section aria-label="Recently landed"><h2>Recently landed</h2>${landed}</section>
    </div>
    <a class="cta" href="${esc(d.early_access)}">Get nuworq for your project: early access</a>`;
}

async function refresh() {
  try {
    const r = await fetch(api, { headers: { accept: 'application/json' } });
    if (r.ok) render(await r.json());
    else if (r.status === 404) $('sentence').textContent = 'This project is not open to watch right now.';
  } catch { /* offline for a moment: the next refresh tries again */ }
}
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 15_000);
