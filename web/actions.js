import { connectCommands, setupSection } from './connect.js';
import { ago } from './ago.js';
import { copyBlock, commandBlocks, copyText } from './copy.js';
import { proposal, sentToast } from './propose.js';
import { errorHtml } from './errors.js';
import { toPrecondition } from './precondition.js';
import { billingSection } from './billing.js';
import { shortcutsHtml } from './shortcuts.js';
import { rank, resultsHtml, confirmHtml, THEMES } from './launcher.js';
import { feedbackForm, feedbackThanks, feedbackMine, attached } from './feedback.js';
import { predict, placeholder } from './instant.js';
import { S, setState, toggleIn, addTo, putIn, removeFrom, PAGE } from './store.js';
import { recent, store, themeNow } from './prefs.js';
import { go, prefetch } from './router.js';
import { $, api, closeModal, loadProjects, modal, prefetchView, refresh, render, scheduleRefresh, toast, toastError, views } from './ui.js';
import { MAC, Z, esc, inline, plural, stepWhere } from './views/html.js';
import { z } from './views/parts.js';

// What the person does (#602): ACTIONS, by the data-action of what they click; KEYS, the shortcuts; and the dialogs
// and the quick launcher they open. Each changes the state through web/store.js and calls render, which draws only
// the regions the change marked.
// A project's view brings only what its depth shows (#501): a deeper depth fetches again, a shallower one shows at once.
function setZoom(zoom) {
  setState({ zoom });
  store.set('zoom', S.zoom);
  views.forget(); // views fetched ahead were for the depth before
  if (S.view?.depth && Z[zoom] > Z[S.view.depth]) refresh({ force: true });
  else render({ force: true });
}

// On the open project, or on the home the project of the card clicked (S.actSlug); with neither, the home's own.
// What's predictable shows on the same frame as the tap (#393, web/instant.js). If the hub refuses, the screen
// goes back to what it was, and the toast says so and why.
async function human(action, body = {}, msg) {
  const before = { view: S.view, home: S.home, item: S.item };
  const shown = foresee(action, body);
  setState({ sending: S.sending + 1 });
  try {
    const slug = S.slug ?? S.actSlug;
    const r = await api(slug ? `/api/p/${encodeURIComponent(slug)}/human/${action}` : `/api/home/${action}`, { method: 'POST', body: JSON.stringify(body) });
    setState({ sending: S.sending - 1 });
    if (msg) toast(msg);
    await refresh();
    return r;
  } catch (e) {
    setState({ sending: S.sending - 1 });
    if (shown) { setState(before); render({ force: true }); scheduleRefresh(); }
    toastError(e, shown ? 'Not changed, so it is back as it was: ' : '');
  }
}
function foresee(action, body) {
  const next = { view: predict(S.view, action, body), home: predict(S.home, action, body), item: predict(S.item, action, body) };
  if (!next.view && !next.home && !next.item) return false;
  setState(Object.fromEntries(Object.entries(next).filter(([, v]) => v)));
  render({ force: true });
  return true;
}

// Archive or delete the open project, then leave it: it is no longer in the list.
async function removeProject(action, body, msg) {
  try {
    await api(`/api/p/${encodeURIComponent(S.slug)}/human/${action}`, { method: 'POST', body: JSON.stringify(body) });
    closeModal();
    await loadProjects();
    go('');
    toast(msg);
  } catch (e) {
    toastError(e);
  }
}

export function setTheme(t) {
  if (t === 'device') { try { localStorage.removeItem('nuworq:theme'); } catch {} } else store.set('theme', t);
  const root = document.documentElement;
  root.classList.add('theming'); // the other theme at once: no transition eases it in
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theming')));
  render({ force: true, also: ['rail'] }); // the rail's Appearance shows the choice
}
// The same as a sentence, for the Settings dialog (#213): the limit and the budget, both always said.
function staffWords(s) {
  if (!s) return '';
  const said = `${s.workers ? `Up to ${s.workers} at once` : 'As many at once as each runner allows'}, ${s.budget != null ? `$${s.budget.toFixed(2)} a day` : 'no daily budget'}`;
  return s.paused ? `${said}. Paused: no new workers start.` : s.stopped === 'budget' ? `${said}. Today's budget is spent.` : `${said}.`;
}

function connectStep(r) {
  const c = connectCommands(S.info ?? { url: location.origin }, location, r.slug);
  const refused = r.refused?.length ? `<div class="bad">${r.refused.map((x) => `<p>✗ Not linked: ${esc(x.error)}.${x.hint ? ` ${esc(x.hint)}` : ''}</p>`).join('')}</div>` : '';
  modal(`<p class="faint">Step 3 of 3 · connect a machine</p>
    <h2>${esc(r.name)} is ready</h2>
    ${r.remotes?.length ? `<p class="lead">Linked: ${r.remotes.map((x) => `<code>${esc(x)}</code>`).join(' ')}</p>` : ''}${refused}
    ${c.clone ? `<h4>Get nuworq on the machine (once)</h4>${commandBlocks(c.clone)}` : ''}
    <h4>Set it up for ${esc(S.me.org)}</h4><p class="lead">Paste it in a terminal, in a clone of the repository. It installs nuworq (Node 24 or newer), signs you in through the browser, saves a fresh agent token for this workspace, and registers nuworq with Claude Code, Codex, opencode and pi if they're installed. Then it asks to staff ${esc(r.name)} with workers and start an operator.</p>${commandBlocks(c.setup)}
    <h4>Then, and after any restart</h4><p class="lead">The runner with automatic workers, and an operator for each project that isn't parked, each in its own terminal. It starts only what's missing.</p>${commandBlocks(c.up)}
    ${setupSection()}
    <div class="foot"><button class="btn primary" data-action="goto-new" data-slug="${esc(r.slug)}">Open the board</button></div>`);
}

// Staffing (#174): what nuworq run does here, set on the hub so it can change from a phone. Runners follow it at
// their next poll. Pause is one tap and says what happens to running workers; the numbers are blank for "no limit".
// Cheaper models (#347): one switch, set about once, and the tiers it picks from, cheapest first. Claude's show;
// the other agents' sit one tap away, since most runners run Claude.
function staffingModal(back) {
  const s = S.view?.project?.staffing ?? {};
  const m = s.models ?? { on: false, tiers: {} };
  const tier = (agent, label) => `<label>${label}<input id="st-tiers-${agent}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="The runner's --model" value="${esc((m.tiers[agent] ?? []).join(', '))}"></label>`;
  modal(`${back ? '<button class="link back" data-action="settings">← Settings</button>' : ''}<h2 data-staffing data-back="${back ? 1 : ''}">Staffing</h2>
    <p class="lead">What <code>nuworq run</code> does here. Runners follow it at their next poll.</p>
    <div class="form"><label>Workers at once<input id="st-workers" type="number" inputmode="numeric" min="1" max="100" placeholder="Each runner's own --workers" value="${s.workers ?? ''}"></label>
    <label>Daily budget, dollars (UTC days)<input id="st-budget" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="No budget" value="${s.budget ?? ''}"></label></div>
    <p class="faint">Spent here today: $${(s.spent_today ?? 0).toFixed(2)}. Once it reaches the budget, no new workers start until tomorrow.</p>
    <div class="setting" data-new="model-routing"><div class="body"><div class="h" id="set-models">Cheaper models where they do as well</div>
      <div class="s">${m.on ? 'On: building starts on the top model below and landing and tidying on the cheapest, until results show a cheaper one meets the quality bar. A failed attempt steps up one. Reviews and shaping always use the top one.' :'Off: every worker runs on its runner\'s own model.'}</div></div>
      <button class="switch" role="switch" aria-checked="${m.on}" aria-labelledby="set-models" data-action="${m.on ? 'models-off' : 'models-on'}"></button></div>
    <div class="form">${tier('claude', 'Claude models, cheapest first')}
    <details><summary>Codex, opencode and pi</summary>${tier('codex', 'Codex models, cheapest first')}${tier('opencode', 'opencode models (provider/model), cheapest first')}${tier('pi', 'pi models (provider/model), cheapest first')}</details>
    <label data-new="model-trials">Building jobs that try one model down, percent<input id="st-trial" type="number" inputmode="numeric" min="0" max="100" step="1" value="${m.trial ?? 10}"></label>
    <label>Building jobs raced against the top model, percent<input id="st-race" type="number" inputmode="numeric" min="0" max="100" step="1" value="${m.race ?? 0}"></label></div>
    <p class="faint">Trials teach nuworq what each model can do. Only rote and standard items that aren't "now" or operator-only, while there's budget left today. 0 turns one off.</p>
    <fieldset class="quality" data-new="model-quality"><legend>Quality bar</legend>
      ${Object.entries(m.qualities ?? {}).map(([k, q]) => `<label class="check-label"><input type="radio" name="st-quality" value="${k}" ${(m.quality ?? 'balanced') === k ? 'checked' : ''}> <span><b>${esc(q.label)}</b>: ${esc(q.means)}</span></label>`).join('')}
      <p class="faint">Once a model has 20 finished jobs of a kind (building standard items, say), and so has the top one, each job of that kind runs on the cheapest model that meets the bar. Until then: the top model for building, the cheapest for landing and tidying.</p></fieldset>
    <div class="foot"><button class="btn ghost" data-action="staffing-pause" data-paused="${s.paused ? 1 : 0}">${s.paused ? 'Resume' : 'Pause'}</button><button class="btn primary" data-action="staffing-save">Save</button></div>`);
}
const tiersTyped = () => Object.fromEntries(['claude', 'codex', 'opencode', 'pi'].map((a) => [a, val(`st-tiers-${a}`)]));
// The switch redraws the dialog in its new state, keeping what was typed and not yet saved.
async function modelRouting(on) {
  const back = !!$('#modal [data-staffing]')?.dataset.back;
  const typed = { workers: val('st-workers'), budget: val('st-budget'), trial: val('st-trial'), race: val('st-race') };
  const r = await human('settings', { model_routing: on, model_tiers: tiersTyped() }, on ? 'Cheaper models are on: runners pick each job\'s model at their next poll' : 'Cheaper models are off');
  if (!r || !$('#modal [data-staffing]')) return;
  staffingModal(back);
  $('#st-workers').value = typed.workers ?? '';
  $('#st-budget').value = typed.budget ?? '';
  $('#st-trial').value = typed.trial ?? '';
  $('#st-race').value = typed.race ?? '';
  $('#modal .switch')?.focus();
}

// A watchable project's public page (#358), beside this app: /live/<slug>, or /w/<workspace>/live/<slug>.
const liveLink = (slug) => `${location.origin}${location.pathname.replace(/[^/]*$/, '')}live/${encodeURIComponent(slug)}`;

// A project's settings (#213), changed about monthly, so one step from the header rather than in it. One row
// each: a fixed name, what it does, one control. A switch shows on or off; a button says what it does.
function settingsModal() {
  const P = S.view?.project;
  if (!P) return;
  const row = (id, name, what, control) => `<div class="setting"><div class="body"><div class="h" id="set-${id}">${name}</div><div class="s">${what}</div></div>${control}</div>`;
  const sw = (id, on, action) => `<button class="switch" role="switch" aria-checked="${on}" aria-labelledby="set-${id}" data-action="${action}"></button>`;
  modal(`<h2 data-settings>Settings</h2>
    <p class="lead">How ${esc(P.name)} is staffed, kept current and linked to GitHub.</p>
    ${row('runner', 'Staff it with nuworq run', `Runners start headless workers here whenever work is waiting. They can cost money.${P.runner
      ? `<span class="staff-words">${esc(staffWords(P.staffing))} <button class="link" data-action="staffing-from-settings">Change</button></span>` : ''}`,
      sw('runner', !!P.runner, P.runner ? 'runner-off' : 'runner-on'))}
    ${row('fresh', 'Keep it fresh weekly', 'Once a week an agent updates dependencies, the runtime and CI actions, and proposes each breaking upgrade.',
      sw('fresh', !!P.fresh, P.fresh ? 'fresh-off' : 'fresh-on'))}
    <div data-new="security-reviews">${row('security', 'Security reviews', P.security
    ? 'On: before each release an agent that built none of it reviews what it ships, and the release waits for it. Each month, one area in turn.'
    : 'Before each release, a review of what it ships by an agent that built none of it; each month, one area in turn.',
      sw('security', !!P.security, P.security ? 'security-off' : 'security-on'))}</div>
    <div data-new="releases">${row('releases', 'Release per milestone', P.releases === 'milestone'
    ? 'On: when a milestone finishes, the hub drafts "Release vX.Y.Z" with its changelog and upgrade notes, for you to edit and sign.'
    : 'When a milestone finishes, the hub drafts the next release: its version, changelog and upgrade notes.',
    sw('releases', P.releases === 'milestone', P.releases === 'milestone' ? 'releases-off' : 'releases-on'))}
    ${row('release-now', 'Release now', 'A patch for a fix that can\'t wait, or whatever landed since the last release, drafted the same way.',
      '<button class="btn" data-action="release-now">Draft</button>')}</div>
    <div data-new="live-view">${row('live', 'Anyone can watch', P.live
    ? `On: anyone with <a href="${esc(liveLink(P.slug))}" target="_blank" rel="noopener">the link</a> sees item titles, agents, models, Flow and totals. Nothing else.`
    : 'A public, read-only page of what agents are doing here. Off until you turn it on.',
    sw('live', !!P.live, P.live ? 'live-off' : 'live-on'))}</div>
    ${row('github', 'GitHub', P.github ? 'Connected: pull requests and CI results link to items.' : 'Link pull requests and CI results to items.',
      `<button class="btn${P.github ? '' : ' primary'}" data-action="github">${P.github ? 'Manage' : 'Connect GitHub'}</button>`)}
    <h3>This project</h3>
    ${P.parked
      ? row('park', 'Park', 'Parked: no new work starts and nothing here asks for you.', '<button class="btn" data-action="unpark-project">Unpark</button>')
      : row('park', 'Park', 'Pause it: no new work starts and nothing here asks for you until you unpark it.', '<button class="btn" data-action="park">Park</button>')}
    ${row('remove', 'Remove', 'Archive it (history kept), or delete it for good.', '<button class="btn" data-action="remove-project">Remove…</button>')}
    <div class="foot"><button class="btn primary" data-action="close-modal">Done</button></div>`);
}
// A setting changed from the dialog shows its new state there. The redraw replaces the control that changed it,
// so focus goes back to that row's control: otherwise it falls behind the dialog, and the next Tab or a screen
// reader starts over from the page.
const settingsOpen = () => !!$('#modal [data-settings]');
async function setting(body, msg) {
  const row = document.activeElement?.closest?.('#modal .setting')?.querySelector('.h')?.id;
  const redraw = () => {
    if (!settingsOpen()) return;
    settingsModal();
    if (row) $(`#${row}`)?.closest('.setting')?.querySelector(':scope > button')?.focus();
  };
  const sent = human('settings', body, msg);
  redraw(); // the switch shows its new state at once (#393), and goes back if the hub refuses
  const r = await sent;
  redraw();
  return r;
}

// The board's + Work (#389): Propose makes the person's proposal; Add to Ready puts it straight into the queue.
async function addWork(ready) {
  const more = S.addMore, pre = more ? val('nw-pre') : '';
  const body = proposal({ title: val('nw-title'), acceptance: more ? val('nw-acceptance') : '', summary: more ? val('nw-summary') : '',
    priority: S.drafts['nw-priority'], precondition: pre ? toPrecondition(pre) : null, ready });
  if (!body) { $('#nw-title')?.focus(); return toast('Say what should be true when it\'s done', true); }
  await human('create', body, sentToast({ ready, waits: !!pre }));
  clearDraft('nw-title', 'nw-summary', 'nw-acceptance', 'nw-priority', 'nw-pre');
  setState({ addWork: false, addMore: false });
  render({ force: true });
}

const loadInfo = async () => { if (S.info == null) setState({ info: await api('/api/info').catch(() => ({ url: location.origin })) }); };

async function connect() {
  await loadInfo();
  const slug = S.slug ?? 'my-project';
  const c = connectCommands(S.info, location, slug);
  const url = c.url;
  const gh = await api('/api/github/app').catch(() => null);
  const where = S.view?.project.path;
  modal(`<h2>Connect an agent</h2>
    <p class="lead">Any model can work here, and many agents at once. Set a machine up once: agents find their project from the folder they're in, and anywhere else the hub sends them to the work that matters most.</p>
    <h4>Set up this machine (once)</h4>
    <p class="lead">Paste it in a terminal, in a clone of the project. ${c.verified ? '<span data-new="verified-install">It downloads this hub\'s newest signed release and checks its signature against nuworq\'s release key; if that doesn\'t match, it stops before anything installs.</span> Then it installs nuworq (Node 24 or newer: <code>node --version</code>; older or missing, get it from nodejs.org), which keeps itself up to date.' : c.install ? 'It installs nuworq from this hub (Node 24 or newer: <code>node --version</code>; older or missing, get it from nodejs.org), and keeps it up to date.' : 'This hub serves no package of nuworq (it doesn\'t run from a git checkout), so install nuworq the way this hub was installed first.'} It signs you in through the browser, then asks, one at a time, to install the Claude Code plugin, staff the project with workers here, and start an operator, and says how to start a shaper. That one block is all there is to copy. <code>nuworq disconnect</code> undoes it all.</p>${commandBlocks(c.setup)}
    <details class="setup-fold" data-new="setup-folded"><summary>What connect sets up, to do by hand</summary>
    ${setupSection()}
    <h4>Then, and after any restart</h4><p class="lead">The first two for every project that isn't parked, in one command: the runner with automatic workers, and an operator in its own terminal for each (tmux when you have it). Run it again any time: it starts only what's missing. <code>nuworq down</code> stops it all.</p>${commandBlocks(c.up)}
    </details>
    ${gh ? `<h4>GitHub App (once, for this hub)</h4>${appStatus(gh)}` : ''}
    ${where || S.view?.project.remotes?.length ? '' : `<p class="lead">⚠ The hub doesn't know ${esc(S.view?.project.name ?? 'this project')}'s repository yet. Start the first worker from a clone of it (add --here), or link the repo in the project header, so later workers find it.</p>`}
    ${z() >= 2 ? `<h3>Setting up by hand</h3>
    <h4>Workers in this terminal</h4><p class="lead">One per waiting item, on the projects you let it staff, each in its own git worktree and branch. Ctrl-C stops them. Add <code>--browser</code> for workers that check UI work.</p>${commandBlocks(c.run)}
    <p class="lead">One worker on its own, wherever work is waiting:</p>${commandBlocks(c.worker)}
    <p class="lead">What <code>nuworq connect</code> does for you. No token or address goes in these: connect saved both, and <code>nuworq mcp</code> reads them.</p>
    <h4>The Claude Code plugin</h4><p class="lead">The MCP server and the nuworq skills in one install. Connect this machine all the same: the plugin holds no token.</p>${commandBlocks(c.plugin)}
    <h4>Claude Code</h4>${commandBlocks(c.claude)}
    <h4>OpenAI Codex (~/.codex/config.toml)</h4>${copyBlock(c.codex)}
    <h4>pi (1.4 or newer)</h4><p class="lead">Connect registers it when pi is installed; by hand, it's one command. pi workers get a config folder of their own, so your pi extensions, skills and sign-ins stay out: give the model's provider key in the environment. pi has no sandbox, so its workers run only on projects without a remote, and can read this machine's keys: starting one takes --can-read-keys.</p>${commandBlocks(c.pi)}${commandBlocks(c.piWorker)}
    <h4>opencode, Goose, Cline, LM Studio or any MCP client (open-weight models included)</h4>${copyBlock(c.mcp)}
    <h4>Any agent with a shell (no MCP needed)</h4>${commandBlocks(c.guide)}
    <p class="lead" style="margin-top:var(--sp-2)">Add a line to the repo's AGENTS.md or CLAUDE.md: <i>"Coordinate work through nuworq: run the command above and follow it."</i></p>
    <h4>Your own agent loop</h4><p class="lead">Tool schemas: <a href="api/tools?format=openai" target="_blank">OpenAI</a> · <a href="api/tools?format=anthropic" target="_blank">Anthropic</a> · <a href="api/tools?format=mcp" target="_blank">MCP</a>. POST to <code>${esc(url)}/api/p/${esc(slug)}/agent/&lt;tool&gt;</code> with header <code>x-nuworq-agent: &lt;name&gt;</code>. The agent guide: <a href="agents.md?project=${encodeURIComponent(slug)}" target="_blank">/agents.md</a></p>`
      : '<p class="lead">Setting an agent tool up by hand, or your own agent loop? It\'s at <button class="link" data-action="connect-deep">depth 30m</button>.</p>'}
    <div class="foot"><button class="btn primary" data-action="close-modal">Done</button></div>`);
}

async function notifySettings() {
  let n;
  try { n = await api('/api/notify'); } catch (e) { return toastError(e); }
  setState({ notifyPerson: n.person }); // who "only what needs me" means
  const rows = n.channels.map((c) => `<div class="inline-form"><span><b>${esc(c.kind)}</b> <code>${esc(c.url)}</code> <span class="faint">${c.person ? `${c.person === n.person ? 'you' : esc(c.person)}: only what they own` : 'everyone'}${n.requests?.includes(c.id) ? ' · early-access requests reach you here' : ''}</span> ${c.failing ? `<span class="bad">⚠ failing: ${esc(c.last_error)}</span>` : ''}</span>
    <button class="btn ghost small" data-action="notify-weekly" data-id="${c.id}" data-on="${c.weekly ? 0 : 1}" aria-pressed="${c.weekly}" title="Once a week, one line per project: items landed, your actions, cost, escapes">Weekly line: ${c.weekly ? 'on' : 'off'}</button>
    <button class="btn ghost small" data-action="notify-remove" data-id="${c.id}">Remove</button></div>`).join('');
  modal(`<h2>Notifications</h2>
    <p class="lead">When something new needs you (a blocking question, work to verify, "what matters most?"), nuworq sends one message, batched over 2 minutes, with a link. Healthy work sends nothing. Once a week, each channel also gets one line per project that was busy: what landed, your actions, the cost and escapes. Turn it off per channel.</p>
    ${rows || '<p class="lead faint">No channels yet, so you only learn that something needs you when you open the dashboard. Add one below.</p>'}
    ${n.requests && !n.requests.length ? `<p class="lead warn">No channel here hears about early-access requests. Add one below with "Only what needs me" checked.</p>` : ''}
    <h4>Add a channel</h4>
    <div class="inline-form notify-add"><select id="nt-kind">${Object.keys(n.kinds).map((k) => `<option value="${k}">${k}</option>`).join('')}</select>
      <input id="nt-url" placeholder="https://ntfy.sh/your-secret-topic, a Slack webhook, or any URL"><button class="btn primary small" data-action="notify-add">Add</button></div>
    ${n.person ? `<label class="faint"><input type="checkbox" id="nt-mine" checked> Only what needs me (${esc(n.person)}); unchecked, an owner's channel gets everyone's</label>` : ''}
    <p class="lead" id="nt-help"></p>
    <div class="foot">${n.channels.length ? '<button class="btn" data-action="notify-test">Send a test</button>' : ''}<button class="btn primary" data-action="close-modal">Done</button></div>`);
  // Only the chosen kind's help (#155): the others are noise until picked.
  const example = { ntfy: 'https://ntfy.sh/topic', slack: 'https://hooks.slack.com/…' };
  const help = () => {
    const k = $('#nt-kind').value;
    $('#nt-help').innerHTML = `<b>${esc(k)}</b>: ${esc(n.kinds[k])}`;
    $('#nt-url').placeholder = example[k] ?? 'https://…';
  };
  $('#nt-kind').addEventListener('change', help);
  help();
}

// The workspace's settings (#231), for its owners while the hub takes payments: billing in one plain line,
// Upgrade while Free (#228), and Stripe's own page to change the card, see invoices or cancel. A failed payment
// leads, in warning color. Stripe sends the owner back to #/settings, which opens this again.
export async function workspaceSettings({ again = false } = {}) {
  if (again && !$('#ws-settings')) return; // closed meanwhile
  let b;
  try { b = await api('/api/billing'); } catch (e) { return again || toastError(e); }
  setState({ billing: b });
  modal(`<h2 id="ws-settings">Workspace settings</h2>${billingSection(b, { esc, done: S.checkoutDone })}`);
  // Back from Checkout: look again soon, until the webhook has made it paid.
  if (S.checkoutDone && b.plan === 'free') setTimeout(() => workspaceSettings({ again: true }), 5000);
  else setState({ checkoutDone: false });
}

// Where the hub's GitHub App stands (/api/github/app), one line and its next step, so a person who closed a
// tab mid-flow knows where they are. Nothing when there's no app and this person can't make one.
function appStatus(st) {
  if (!st || (st.state === 'none' && !st.can_create)) return '';
  const [line, act] = st.state === 'installed'
    ? [`Installed${st.repositories == null ? '' : ` on ${plural(st.repositories, 'repository', 'repositories')}`}${st.slug ? ` as <code>${esc(st.slug)}</code>` : ''}: workers push there with a token for one repository, for an hour.`,
      st.install_url ? `<a class="btn small" href="${esc(st.install_url)}" target="_blank" rel="noopener">Manage on GitHub</a>` : '']
    : st.state === 'created'
      ? [`Created${st.slug ? ` as <code>${esc(st.slug)}</code>` : ''}, not installed: it can't reach any repository yet. GitHub asks which ones it may use.`, '<a class="btn primary small" href="api/github/install">Install</a>']
      : ['No GitHub App yet. Workers push through it: a token for one repository, for an hour, and nobody holds a lasting GitHub credential. GitHub asks you to confirm it, then where to install it.', '<a class="btn primary small" href="api/github/app/new">Create</a>'];
  return `<div class="app-status ${st.state}" data-new="github-app-status"><span class="dot"></span><p>${line}</p>${act}</div>`;
}

// Back from installing the app (GitHub sends the person to the app's setup_url with setup_action): say where
// it stands now, and open "+ Project" on the repositories it can see.
export async function backFromGitHub() {
  const st = await api('/api/github/app?fresh=1').catch(() => null);
  if (st) setState({ info: { ...S.info, github_app: st.slug || S.info?.github_app || true } });
  if (st?.state === 'installed') toast(`GitHub App installed${st.repositories == null ? '' : ` on ${plural(st.repositories, 'repository', 'repositories')}`}: pick one to make it a project`);
  else if (st) toast('Back from GitHub, but the app isn\'t installed anywhere yet', true);
  newProject();
}

// Whether each repository's Dependabot alerts come in as items (#180): green when they do; otherwise what
// to do, as numbered steps with the exact place, and how to see it worked.
function alertLines(alerts = []) {
  return alerts.map((a) => `<div class="app-status alerts ${a.state === 'on' ? 'installed' : 'created'}"><span class="dot"></span><div><p>${esc(a.line)}</p>${a.steps ? `<ol>${a.steps.map((s) => `<li>${inline(s.do)}${s.where ? `: ${stepWhere(s.where)}` : ''}${s.check ? `<br><small>${inline(s.check)}.</small>` : ''}</li>`).join('')}</ol>` : ''}</div></div>`).join('');
}

async function githubSettings() {
  await loadInfo();
  const P = S.view.project;
  const hook = `${S.info.url}/api/hooks/github/${encodeURIComponent(P.slug)}`;
  const st = S.info.workspace ? null : await api('/api/github/app').catch(() => null);
  const manual = `<p class="lead">A webhook links pull requests to items (a <code>nuworq/&lt;agent&gt;</code> branch, or <code>#N</code> in the PR title) and shows CI results on them. Failing CI on work you're verifying shows up under "Needs you".</p>
    <h4>1. In the repo on GitHub: Settings → Webhooks → Add webhook</h4>
    <p class="lead">Payload URL (GitHub must be able to reach it; see docs/DEPLOY.md):</p>${copyBlock(hook)}
    <p class="lead">Content type <code>application/json</code>. Events: <i>Pull requests</i>, <i>Check suites</i>, <i>Check runs</i>, <i>Statuses</i>, <i>Dependabot alerts</i>.</p>
    <h4>2. The same secret, there and here</h4>
    <div class="inline-form"><input id="gh-secret" placeholder="${P.github ? 'A secret is set; enter a new one to replace it' : 'A long random secret'}"><button class="btn small" data-action="github-generate">Generate</button></div>`;
  const disconnect = P.github ? '<button class="btn ghost" data-action="github-disconnect">Disconnect</button>' : '';
  // No app to offer (a workspaces hub): the webhook is the only way, as before.
  if (!st) {
    return modal(`<h2>GitHub</h2>${manual}
      <div class="foot">${disconnect}<button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="github-save">Save</button></div>`);
  }
  // The recommended path first (#154): the hub's GitHub App serves every project with no per-repository setup;
  // the per-project webhook is the fallback, folded away unless this project already uses it.
  const lead = st.state === 'none'
    ? `<div class="app-status none"><span class="dot"></span><p>No GitHub App yet. It links pull requests and CI results to items and brings issues in as proposals, for every project at once, with no setup per repository. Workers push through it with a token for one repository, for an hour.
      ${st.can_create ? 'GitHub asks you to confirm it, then where to install it.</p><a class="btn primary small" href="api/github/app/new">Create</a>' : 'Only an owner can create it: ask whoever runs this hub.</p>'}</div>`
    : `${appStatus(st)}<p class="lead" id="gh-covered">${st.state === 'installed' ? 'Checking whether it covers this project\'s repository…' : ''}</p><div id="gh-alerts" data-new="dependabot-alerts"></div>`;
  modal(`<h2>GitHub</h2>${lead}
    <details ${P.github ? 'open' : ''}><summary>Without the app: a webhook for this project${P.github ? ' (connected)' : ''}</summary>${manual}
      <div class="foot">${disconnect}<button class="btn" data-action="github-save">Save the webhook</button></div></details>
    <div class="foot"><button class="btn ghost" data-action="close-modal">Close</button></div>`);
  if (st.state === 'installed') appCovers(P).then((line) => { const el = $('#gh-covered'); if (el) el.innerHTML = line; });
  if (st.state === 'installed') api(`/api/p/${encodeURIComponent(P.slug)}/github`).then((r) => { const el = $('#gh-alerts'); if (el) el.innerHTML = alertLines(r.alerts); }).catch(() => {});
}

// Whether the hub's installed GitHub App can see this project's repository, as one line for the GitHub dialog.
async function appCovers(P) {
  const repos = P.remotes.filter((r) => r.startsWith('github.com/'));
  if (!repos.length) return 'This project has no GitHub repository linked yet: link one in the project header and the app covers it once it is installed there.';
  try {
    for (const r of repos) {
      const { repos: seen } = await api(`/api/github/repos?q=${encodeURIComponent(r.slice('github.com/'.length).toLowerCase())}`);
      if (seen.some((x) => x.repo === r)) return `✓ It covers <code>${esc(r)}</code>: nothing else to set up for this project.`;
    }
    return `It isn't installed on ${repos.map((r) => `<code>${esc(r)}</code>`).join(', ')} yet. ${installLink('Install it there')}, and this project is covered.`;
  } catch {
    return ''; // can't tell (only owners and stewards may list repositories): say nothing rather than guess
  }
}

// "+ Project": pick one of the repositories the GitHub App can see, or (no app, or a workspaces hub) by name.
function newProject() {
  const gh = S.info?.github_app;
  const picker = gh && gh !== 'create' && !S.info?.workspace;
  const why = S.info?.workspace ? 'On a hub with workspaces, add a project by name for now: the shared GitHub App would list other workspaces\' repositories.'
    : gh === 'create' ? 'To pick a repository instead, <a href="api/github/app/new">create the GitHub App</a> (one click) and install it on your repositories.'
    : !gh ? 'With the hub\'s GitHub App, you could pick a repository here instead; an owner creates it from Connect an agent.' : '';
  modal(`<h2>New project</h2>
    ${picker ? `<p class="lead">Pick a repository the nuworq GitHub App is installed on. Install it on more from GitHub to see them here.</p>
      <div class="form"><label>Search<input id="np-q" placeholder="owner/name"></label></div><div id="np-repos" class="repo-list">${placeholder(4, { head: false })}</div>
      <details><summary>Or add one by name</summary>` : `<p class="lead">${why} Agents also create projects when they check in to a new name.</p>`}
    <div class="form"><label>Name<input id="np-name" placeholder="e.g. llm-proxy"></label>
    <label>Repository (optional): its git remote, so agents in a clone find the project<input id="np-remote" placeholder="e.g. github.com/acme/llm-proxy"></label>
    <label>Mission (optional): the north star every agent reads<textarea id="np-mission" placeholder="What is this for? What matters most?"></textarea></label>
    <label class="check-label"><input type="checkbox" id="np-staff"> Let <code>nuworq run</code> staff it: it starts headless workers whenever work is waiting, and they can cost money. Off until you say; Settings changes it later.</label></div>
    ${picker ? '</details>' : ''}
    <div class="foot"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="create-project">Create by name</button></div>`);
  if (!picker) return setTimeout(() => $('#np-name')?.focus(), 0);
  let timer;
  $('#np-q')?.addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => loadRepos(e.target.value.trim(), 1), 250); });
  setTimeout(() => $('#np-q')?.focus(), 0);
  loadRepos('', 1);
}

// GitHub's page for choosing which repositories the hub's app may see.
const installLink = (text) => {
  const slug = typeof S.info?.github_app === 'string' ? S.info.github_app : '';
  const href = slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : 'https://github.com/settings/installations';
  return `<a href="${href}" target="_blank" rel="noopener">${esc(text)}</a>`;
};

async function loadRepos(q, page) {
  const box = $('#np-repos');
  if (!box) return;
  try {
    const r = await api(`/api/github/repos?q=${encodeURIComponent(q)}&page=${page}`);
    const rows = r.repos.map((x) => x.project
      ? `<div class="row-item"><div class="body"><div class="h">${esc(x.repo.replace('github.com/', ''))}</div><div class="s">already the project <a data-action="goto" data-slug="${esc(x.project)}">${esc(x.project)}</a></div></div></div>`
      : `<button class="row-item clickable pick-repo" data-action="pick-repo" data-repo="${esc(x.repo)}" data-desc="${esc(x.description)}"><div class="body"><div class="h">${esc(x.repo.replace('github.com/', ''))}${x.private ? ' <span class="tag">private</span>' : ''}</div>${x.description ? `<div class="s">${esc(x.description)}</div>` : ''}</div></button>`).join('');
    box.innerHTML = (page > 1 ? box.dataset.html ?? '' : '') + (rows ? `<div class="rows">${rows}</div>` : (page === 1 ? `<p class="faint">${q ? 'No repository matches.' : `The app is installed on no repositories yet. ${installLink('Install it on your repositories')}, then come back here.`}</p>` : ''))
      + (rows && page === 1 && !q ? `<p class="faint" style="margin-top:var(--sp-2)">Not listed? ${installLink('Install the app on more repositories')}.</p>` : '');
    box.dataset.html = box.innerHTML;
    if (r.next_page) box.insertAdjacentHTML('beforeend', `<button class="btn ghost small" data-action="more-repos" data-q="${esc(q)}" data-page="${r.next_page}">More</button>`);
  } catch (e) { box.innerHTML = `<p class="faint">${errorHtml(e, esc)}</p>`; }
}

// ── the quick launcher (#290, web/launcher.js): ⌘K or the rail's Search ──
// Its index comes once per opening; every keystroke after that is matched here, with no request.
export const L = { open: false, index: null, sel: 0, results: [], confirming: null };
async function openLauncher() {
  const el = $('#launcher');
  Object.assign(L, { open: true, sel: 0, confirming: null });
  el.innerHTML = `<div class="ln-box" role="dialog" aria-label="Quick launcher">
    <input id="ln-q" type="text" enterkeyhint="go" placeholder="A number, a few letters, or what to do…" autocomplete="off" spellcheck="false" role="combobox" aria-controls="ln-list" aria-expanded="true">
    <div id="ln-list" class="ln-list" role="listbox"></div></div>`;
  el.hidden = false;
  $('#ln-q').focus();
  $('#ln-q').addEventListener('input', () => { L.sel = 0; L.confirming = null; drawLauncher(); });
  drawLauncher();
  try { L.index = await api('/api/launcher'); } catch (e) { if (!L.index) { closeLauncher(); return toastError(e); } }
  if (L.open) drawLauncher({ keep: true });
}
export function drawLauncher({ keep = false } = {}) {
  const list = $('#ln-list');
  if (!list) return;
  if (!L.index) { list.innerHTML = placeholder(3, { head: false }); return; }
  if (L.confirming) { list.innerHTML = confirmHtml(L.confirming, { esc }); return; }
  // Moving through the list keeps it as it is; typing (or the index arriving) ranks it again.
  if (!keep || !L.results.length) L.results = rank(L.index, $('#ln-q').value, { theme: themeNow(), current: S.slug, view: S.view, zoom: S.zoom, role: S.person?.role ?? 'owner', billingOwner: !!S.billing?.owner, recent: recent() });
  L.sel = Math.min(L.sel, Math.max(0, L.results.length - 1));
  list.innerHTML = resultsHtml(L.results, { sel: L.sel, stages: L.index.stages, esc });
  list.querySelector('.ln-row.on')?.scrollIntoView({ block: 'nearest' });
  // The highlighted result starts loading (#503): a project's view, or an item and its project's.
  const run = L.results[L.sel]?.run;
  const to = run?.open?.slug ?? run?.go?.match(/^#\/p\/([^/]+)$/)?.[1];
  if (to) prefetchView(run.open ? to : decodeURIComponent(to));
  if (run?.open?.item) prefetch(run.open.slug, run.open.item);
}
export function closeLauncher() {
  Object.assign(L, { open: false, confirming: null });
  $('#launcher').hidden = true;
  $('#launcher').innerHTML = '';
}
// Run what was picked. A change shows its confirmation first; the second Enter (or Apply) carries it out.
export async function runLauncher(r) {
  if (!r) return;
  if (r.confirm && L.confirming !== r) { L.confirming = r; drawLauncher(); $('#ln-q')?.focus(); return; }
  closeLauncher();
  const x = r.run;
  if (x.go) location.hash = x.go;
  else if (x.action) ACTIONS[x.action]();
  else if (x.theme) { setTheme(x.theme); toast(`Appearance: ${THEMES.find(([k]) => k === x.theme)[1]}`); }
  else if (x.zoom) { setZoom(x.zoom); toast(`Depth ${x.zoom}`); }
  else if (x.open) openAt(x.open);
  else if (x.human) {
    try {
      await api(`/api/p/${encodeURIComponent(x.slug)}/human/${x.human}`, { method: 'POST', body: JSON.stringify(x.body) });
      toast(x.msg);
      await refresh();
    } catch (e) { toastError(e); }
  }
}
// An item's flyout, with the box a command needs focused once it's drawn: its answer, or Send back's note.
function openAt({ slug, item, focus }) {
  if (focus === 'sendback') addTo('reveal', 'dsb');
  const before = location.hash;
  go(slug, item);
  if (location.hash === before) render({ force: true });
  if (!focus) return;
  const id = focus === 'sendback' ? `sb:${item}` : focus;
  let tries = 0;
  const t = setInterval(() => {
    const el = $(`#drawer [id="${id}"]`);
    if (el || ++tries > 60) { clearInterval(t); el?.focus(); }
  }, 50);
}
// ── events ──
const val =(id) => (document.getElementById(id)?.value ?? '').trim();
const clearDraft = (...keys) => removeFrom('drafts', ...keys);
// What this person sent as feedback and what happened to each (#297), under the Feedback form or its thanks.
async function showMine({ scroll = false } = {}) {
  const r = await api('/api/feedback/mine').catch(() => null);
  const slot = $('#fb-mine-slot');
  if (!slot || !r) return;
  slot.innerHTML = feedbackMine(r.feedback, esc, (t) => `${ago(t)} ago`);
  if (scroll) $('#fb-mine')?.scrollIntoView({ block: 'start' });
}

export const ACTIONS = {
  'an-period': (el) => { setState({ period: el.dataset.p, outcomes: null }); render({ force: true }); refresh({ force: true }); },
  zoom: (el) => setZoom(el.dataset.zoom),
  // Show more (#501): the next page of All work or of earlier agents.
  more: (el) => { const k = el.dataset.more; putIn('pages', k, S.pages[k] + PAGE[k]); refresh({ force: true }); },
  goto: (el) => go(el.dataset.slug),
  open: (el) => go(S.slug ?? S.actSlug, el.dataset.item),
  close: () => { go(S.slug); },
  deep: () => { setState({ deep: true }); render({ force: true }); },
  toggle: (el) => { toggleIn('open', el.dataset.key); render({ force: true }); },
  reveal: (el) => { addTo('reveal', el.dataset.key); render({ force: true }); setTimeout(() => document.getElementById(el.dataset.key.replace('dsb', `sb:${S.itemRef}`))?.focus(), 0); },
  stage: (el) => { setState({ stage: S.stage === el.dataset.stage ? null : el.dataset.stage }); render({ force: true }); },
  seen: () => human('seen', {}, 'Marked as seen'),
  theme: (el) => setTheme(el.dataset.appearance),
  autonomy: (el) => human('settings', { autonomy: el.dataset.level }, 'Autonomy changed; agents have been told'),
  'edit-mission': (el) => {
    // A phone clamps a long mission (#711): the first tap shows it whole, the next edits it.
    if (el && el.scrollHeight > el.clientHeight + 1 && !S.open.has(`mission:${S.slug}`)) { addTo('open', `mission:${S.slug}`); render({ force: true }); return; }
    setState({ editMission: true }); render({ force: true }); setTimeout(() => $('#mission-in')?.focus(), 0);
  },
  'cancel-mission': () => { setState({ editMission: false }); clearDraft('mission'); render({ force: true }); },
  'save-mission': async () => { const m = val('mission-in'); setState({ editMission: false }); clearDraft('mission'); await human('settings', { mission: m }, 'Mission saved'); },
  'remote-new': () => { setState({ addRemote: true }); render({ force: true }); setTimeout(() => $('#remote-in')?.focus(), 0); },
  'remote-cancel': () => { setState({ addRemote: false }); clearDraft('remote'); render({ force: true }); },
  'remote-add': async () => { const v = val('remote-in'); if (!v) return; setState({ addRemote: false }); clearDraft('remote'); await human('remote', { add: v }, 'Linked: agents in any clone of it find this project'); },
  'remote-remove': (el) => { if (confirm(`Unlink ${el.dataset.remote}?`)) human('remote', { remove: el.dataset.remote }, 'Unlinked'); },
  'compose-kind': (el) => { setState({ composeKind: el.dataset.kind }); render({ force: true }); },
  'compose-send': async () => {
    const body = val('compose');
    if (!body) return;
    const kind = S.composeKind;
    clearDraft('compose');
    $('#compose').value = '';
    const r = kind === 'note' ? await human('comment', { body }, 'Noted')
      : kind === 'decision' ? await human('decide', { body }, 'Decision recorded: every agent will carry it')
      : await human('steer', { body }, 'Steer sent: agents will acknowledge it');
    // Refused: what they wrote goes back in the box, so nothing is lost.
    if (!r && !$('#compose').value) { putIn('drafts', 'compose', body); $('#compose').value = body; }
  },
  'toggle-add': () => { setState({ addWork: !S.addWork }); if (!S.addWork) setState({ addMore: false }); render({ force: true }); if (S.addWork) setTimeout(() => $('#nw-title')?.focus(), 0); },
  'nw-priority': (el) => { putIn('drafts', 'nw-priority', el.dataset.p); render({ force: true }); },
  'nw-more': () => { setState({ addMore: true }); render({ force: true }); setTimeout(() => $('#nw-acceptance')?.focus(), 0); },
  'add-work': () => addWork(false),
  'add-ready': () => addWork(true),
  answer: (el) => {
    const q = el.dataset.q;
    const decide = document.getElementById(`dec-${q}`)?.checked;
    const keep_parked = document.getElementById(`keep-${q}`)?.checked;
    clearDraft(`ans-${q}`, `dec-${q}`, `keep-${q}`);
    return human('answer', { question: Number(q), answer: el.dataset.answer, decide, keep_parked }, keep_parked ? 'Answered; it stays parked until you unpark it' : decide ? 'Answered, and saved as a decision' : 'Answered; the work is moving again');
  },
  'answer-text': (el) => {
    const q = el.dataset.q;
    const answer = val(`ans-${q}`);
    if (!answer) return toast('Write an answer first', true);
    const decide = document.getElementById(`dec-${q}`)?.checked;
    const keep_parked = document.getElementById(`keep-${q}`)?.checked;
    clearDraft(`ans-${q}`, `dec-${q}`, `keep-${q}`);
    return human('answer', { question: Number(q), answer, decide, keep_parked }, keep_parked ? 'Answered; it stays parked until you unpark it' : 'Answered; the work is moving again');
  },
  // The last tick answers a question without options: say so, since its card leaves Needs you.
  step: async (el) => {
    const r = await human('step', { question: Number(el.dataset.q), step: Number(el.dataset.step), done: !!el.dataset.done });
    if (r?.answered) toast(`Done: all ${r.of} steps completed; the work is moving again`);
  },
  unpark: (el) => human('unpark', { item: el.dataset.item }, 'Unparked: agents can pick it up'),
  confirm: (el) => human('confirm', { question: Number(el.dataset.q) }, 'Assumption confirmed'),
  override: (el) => {
    const q = el.dataset.q;
    const src = el.dataset.src ?? `ov:${q}`;
    const answer = val(src);
    if (!answer) return toast('Say what to do instead', true);
    clearDraft(src);
    removeFrom('reveal', `ov:${q}`);
    return human('answer', { question: Number(q), answer }, 'Overridden: the agent will be steered');
  },
  accept: (el) => human('accept', { item: el.dataset.item }, `Accepted ${el.dataset.item}`),
  // A race's "Keep this one" (#705: not `keep`, which is a field note's Keep below).
  'keep-attempt': async (el) => {
    const r = await human('accept', { item: el.dataset.item, attempt: el.dataset.attempt });
    if (r?.merge) toast(`Kept ${r.kept}'s attempt on ${el.dataset.item}. Now merge ${r.merge}`);
  },
  sendback: (el) => {
    const k = `sb:${el.dataset.item}`;
    const note = val(k);
    if (!note) return toast('Say what is missing; the next agent starts from it', true);
    clearDraft(k);
    removeFrom('reveal', k, 'dsb');
    return human('sendback', { item: el.dataset.item, note }, 'Sent back with your note');
  },
  approve: (el) => human('update', { item: el.dataset.item, stage: 'ready' }, 'Approved: ready for any agent'),
  needs: (el) => human('update', { item: el.dataset.item, needs: JSON.parse(el.dataset.needs || '[]') }, 'Any agent can take it now'),
  pick: (el) => human('pick', { item: el.dataset.item }, `Picked ${el.dataset.item}: the next agent shapes it first`),
  park: () => { if (confirm('Park this project? No new work starts and nothing here will ask for you until you unpark it.')) setting({ parked: true }, 'Parked'); },
  'unpark-project': () => setting({ parked: false }, 'Unparked'),
  settings: () => settingsModal(),
  'remove-project': () => {
    const P = S.view.project;
    modal(`<h2>Remove ${esc(P.name)}</h2>
      <p class="lead"><b>Archive</b> takes it out of the project list and stops agents being sent here. Its items and history are kept, and you can restore it from Archived projects.</p>
      <p class="lead"><b>Delete</b> removes its items, history, notes and the hub's mirror for good, and tokens limited to it lose it. The repository on GitHub is not touched. Type <code>${esc(P.name)}</code> to delete it.</p>
      <div class="form"><input id="rm-confirm" placeholder="${esc(P.name)}"></div>
      <div class="foot"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn ghost" data-action="delete-project">Delete for good</button><button class="btn primary" data-action="archive-project">Archive</button></div>`);
  },
  'archive-project': () => removeProject('archive', {}, 'Archived'),
  'delete-project': () => removeProject('delete', { confirm: val('rm-confirm') }, 'Deleted'),
  archived: async () => {
    try {
      const list = await api('/api/projects?archived=1');
      modal(`<h2>Archived projects</h2>${list.length ? list.map((p) => `<div class="row-item"><div class="body"><div class="h">${esc(p.name)}</div>${p.remotes.length ? `<div class="s">${esc(p.remotes.join(', '))}</div>` : ''}</div>
        <div class="acts"><button class="btn ghost small" data-action="delete-archived" data-slug="${esc(p.slug)}" data-name="${esc(p.name)}">Delete for good</button><button class="btn small" data-action="restore-project" data-slug="${esc(p.slug)}">Restore</button></div></div>`).join('') : '<p class="lead faint">No archived projects. Removing a project archives it: its history is kept, and you can restore it here.</p>'}
        <div class="foot"><button class="btn ghost" data-action="close-modal">Close</button></div>`);
    } catch (e) { toastError(e); }
  },
  // An archived project deleted for good (#155): the same typed-name check as Remove project.
  'delete-archived': (el) => modal(`<h2>Delete ${esc(el.dataset.name)} for good</h2>
    <p class="lead">This removes its items, history, notes and the hub's mirror for good, and tokens limited to it lose it. The repository on GitHub is not touched. Type <code>${esc(el.dataset.name)}</code> to delete it.</p>
    <div class="form"><input id="rm-archived" placeholder="${esc(el.dataset.name)}"></div>
    <div class="foot"><button class="btn ghost" data-action="archived">Back</button><button class="btn" data-action="delete-archived-now" data-slug="${esc(el.dataset.slug)}">Delete for good</button></div>`),
  'delete-archived-now': async (el) => {
    try {
      await api(`/api/p/${encodeURIComponent(el.dataset.slug)}/human/delete`, { method: 'POST', body: JSON.stringify({ confirm: val('rm-archived') }) });
      toast('Deleted for good');
      ACTIONS.archived();
    } catch (e) { toastError(e); }
  },
  'restore-project': async (el) => {
    try {
      await api(`/api/p/${encodeURIComponent(el.dataset.slug)}/human/restore`, { method: 'POST', body: '{}' });
      closeModal();
      await loadProjects();
      go(el.dataset.slug);
      refresh({ force: true }); // restored from its own (missing) page, the address doesn't change
    } catch (e) { toastError(e); }
  },
  'runner-on': () => setting({ runner: true }, '`nuworq run` may now start workers here'),
  'runner-off': () => { if (confirm('Stop nuworq run staffing this project? Runners start no new workers here; running ones finish. Work waits until an agent takes it or you turn it back on.')) setting({ runner: false }, '`nuworq run` will no longer start workers here'); },
  'staff-not-now': () => human('settings', { runner: false }, 'Not staffed. You can let nuworq run staff it later from Settings'),
  staffing: () => staffingModal(),
  'staffing-from-settings': () => staffingModal(true),
  'staffing-save': async () => {
    const r = await human('settings', { run_workers: val('st-workers'), run_budget: val('st-budget'), model_tiers: tiersTyped(), model_trial: val('st-trial'), model_race: val('st-race'), model_quality: $('#modal input[name="st-quality"]:checked')?.value }, 'Staffing saved: runners follow it at their next poll');
    if (r) closeModal();
  },
  'models-on': () => {
    if (confirm('Turn on cheaper models for rote jobs?\n\nLanding and tidy jobs start on the cheapest model you listed (or the runner\'s --model if none). When an attempt is sent back, stalls or is handed off, that item\'s next attempt steps up one model. Building, reviews and shaping stay on the top model. Each routed worker does one job, then stops.\n\nTurn it off any time from here.')) modelRouting(true);
  },
  'models-off': () => modelRouting(false),
  'staffing-pause': (el) => { closeModal(); human('settings', { run_paused: el.dataset.paused !== '1' }, el.dataset.paused === '1' ? 'Staffing resumed' : 'Paused: runners start no new workers here; running ones finish'); },
  'fresh-on': () => setting({ fresh: true }, 'The weekly freshness sweep is on'),
  'security-on': () => setting({ security: true }, 'Security reviews are on: the first one opens within a minute'),
  'security-off': () => { if (confirm('Turn off security reviews? Releases stop waiting for a review of what they ship, and the monthly reviews stop.')) setting({ security: false }, 'Security reviews are off'); },
  'releases-on': () => setting({ releases: 'milestone' }, 'When a milestone finishes, the hub drafts the next release'),
  'releases-off': () => setting({ releases: 'off' }, 'Releases per milestone are off'),
  // The drafted release opens, so the person reads (and can edit) the changelog at once.
  'release-now': async () => {
    const r = await human('release', {}, null);
    if (!r) return;
    toast(`Drafted ${r.title}`);
    closeModal();
    go(S.slug, r.item);
  },
  'live-on': () => {
    if (confirm(`Let anyone watch ${S.view.project.name}, without signing in?\n\nPublic at ${liveLink(S.view.project.slug)}: item numbers and titles, their stage, the agent and model on each, Flow, recently landed items, and totals (landed, sent back, median cycle time, cost per landed).\n\nNever public: summaries, details, evidence, field notes, questions, answers, steering, decisions, emails, tokens or machine names.\n\nYou can turn it off any time.`)) setting({ live: true }, 'Anyone with the link can watch this project');
  },
  'live-off': () => { if (confirm('Take the live view down? Its link stops working at once (copies a proxy cached expire within 15 seconds).')) setting({ live: false }, 'The live view is down'); },
  'fresh-off': () => { if (confirm('Turn off the weekly freshness sweep? This project will stop being kept current: no agent updates its dependencies, runtime or CI actions until you turn it back on.')) setting({ fresh: false }, 'The weekly freshness sweep is off'); },
  drop: (el) => { if (confirm(`Drop ${el.dataset.item}? It stays on the record.`)) human('update', { item: el.dataset.item, stage: 'dropped' }, 'Dropped'); },
  reopen: (el) => human('update', { item: el.dataset.item, stage: 'ready' }, 'Back in Ready'),
  'group-priority': (el) => human('update', { item: el.dataset.item, priority: el.dataset.p }, `${el.dataset.item} is ${el.dataset.p}: everything in the milestone ranks at least ${el.dataset.p}`),
  clarify: (el) => {
    const k = `cl:${el.dataset.item}`;
    const body = val(k);
    if (!body) return;
    clearDraft(k);
    removeFrom('reveal', k);
    return human('steer', { item: el.dataset.item, body }, 'Steer attached to the item');
  },
  'item-steer': (el) => { const k = `ic:${el.dataset.item}`; const body = val(k); if (!body) return; clearDraft(k); return human('steer', { item: el.dataset.item, body }, 'Steer attached: whoever works on it must acknowledge'); },
  'item-note': (el) => { const k = `ic:${el.dataset.item}`; const body = val(k); if (!body) return; clearDraft(k); return human('comment', { item: el.dataset.item, body }, 'Noted'); },
  'edit-item': () => { setState({ editItem: !S.editItem }); clearDraft('ei-title', 'ei-summary', 'ei-acceptance', 'ei-priority', 'ei-race', 'ei-fixes', 'ei-parent'); render({ force: true }); },
  'ei-priority': (el) => { putIn('drafts', 'ei-priority', el.dataset.p); render({ force: true }); },
  'ei-race': (el) => { putIn('drafts', 'ei-race', el.dataset.n); render({ force: true }); },
  'save-item': async (el) => {
    const args = { item: el.dataset.item, title: val('ei-title'), summary: val('ei-summary'), acceptance: val('ei-acceptance'), fixes: val('ei-fixes'), parent: val('ei-parent') };
    if (S.drafts['ei-priority']) args.priority = S.drafts['ei-priority'];
    if (S.drafts['ei-race']) args.race = Number(S.drafts['ei-race']);
    setState({ editItem: false });
    clearDraft('ei-title', 'ei-summary', 'ei-acceptance', 'ei-priority', 'ei-race', 'ei-fixes', 'ei-parent');
    await human('update', args, 'Saved');
  },
  'edit-pre': () => { setState({ editPre: !S.editPre }); render({ force: true }); },
  'save-pre': async (el) => {
    const k = `pre:${el.dataset.item}`;
    const precondition = toPrecondition(val(k));
    setState({ editPre: false });
    clearDraft(k);
    await human('update', { item: el.dataset.item, precondition }, Object.keys(precondition).length ? 'Saved: it waits until that holds' : 'Removed: it no longer waits');
  },
  'remove-pre': (el) => human('update', { item: el.dataset.item, precondition: {} }, 'Removed: it no longer waits'),
  'check-now': (el) => human('check', { item: el.dataset.item }, 'The hub checks it on its next sweep'),
  dismiss: (el) => human('dismiss', { key: el.dataset.key }),
  'dismiss-all': (el) => human('dismiss', { keys: JSON.parse(el.dataset.keys) }),
  // Stripe Checkout for the plan (#228): the hub opens the session, the browser goes there.
  upgrade: async (el) => {
    el.disabled = true;
    try {
      const r = await api('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ plan: el.dataset.plan }) });
      location.href = r.url;
    } catch (e) {
      el.disabled = false;
      toastError(e);
    }
  },
  // One click retires; the toast's Undo brings the same note back (#146).
  retire: async (el) => {
    const note = Number(el.dataset.note);
    const words = el.closest('.row-item')?.querySelector('.h')?.textContent.trim() ?? '';
    if (await human('retire', { note })) toast(`Retired${words ? `: ${words.length > 50 ? `${words.slice(0, 50)}…` : words}` : ''}`, false, { action: 'unretire', note });
  },
  unretire: async (el) => { $('#toast').hidden = true; await human('unretire', { note: Number(el.dataset.note) }, 'Brought back: agents get it again'); },
  always: async (el) => {
    const on = el.dataset.on === '1';
    await human('always', { note: Number(el.dataset.note), on }, on ? 'Every agent gets it now, whatever it works on' : 'Agents get it when it bears on their work');
  },
  // A review's recommendation (#552), one tap each: keep the note, or make its draft a standing decision.
  keep: async (el) => { await human('keep', { note: Number(el.dataset.note) }, 'Kept: agents still get it'); },
  promote: async (el) => { await human('promote', { note: Number(el.dataset.note) }, 'A decision now: every agent gets it, and the note is retired'); },
  // Direction today names its sources: show that row, opening every note if it's one of the hidden ones.
  'memory-src': (el) => {
    addTo('open', `memory:${S.slug}`);
    render({ force: true });
    $(`#main [data-key="note:${el.dataset.note}"]`)?.scrollIntoView({ block: 'center' });
  },
  'feed-all': () => { setState({ feedAll: !S.feedAll }); render({ force: true }); },
  connect: () => connect(),
  'connect-deep': () => { setZoom('30m'); connect(); },
  notify: () => notifySettings(),
  'rail-menu': () => { setState({ railMenu: !S.railMenu }); render({ force: true }); },
  shortcuts: () => modal(shortcutsHtml({ mac: MAC })),
  launcher: () => (L.open ? closeLauncher() : openLauncher()),
  'workspace-settings': () => workspaceSettings(),
  feedback: (_el, { mine = false } = {}) => {
    setState({ feedbackCtx: attached({ href: location.href, version: S.feedback?.version, ua: navigator.userAgent }) });
    modal(feedbackForm(S.feedbackCtx, esc));
    if (!mine) $('#fb-text').focus();
    showMine({ scroll: mine });
  },
  'only-feedback': () => { setState({ onlyFeedback: !S.onlyFeedback }); render({ force: true }); },
  'feedback-send': async (el) => {
    const text = val('fb-text');
    if (!text) return toast('Say what happened first', true);
    el.disabled = true;
    try {
      await api('/api/feedback', { method: 'POST', body: JSON.stringify({ text, ...S.feedbackCtx }) });
      modal(feedbackThanks());
      showMine();
    } catch (e) { el.disabled = false; toastError(e); }
  },
  'billing-portal': async (el) => {
    el.disabled = true;
    try { location.href = (await api('/api/billing/portal', { method: 'POST', body: '{}' })).url; } catch (e) { el.disabled = false; toastError(e); }
  },
  github: () => githubSettings(),
  'github-generate': () => {
    const el = $('#gh-secret');
    el.value = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
    el.select();
    toast('Copy it into GitHub before you save: it is not shown again');
  },
  'github-save': async () => {
    const secret = val('gh-secret');
    if (!secret) return toast('Enter or generate a secret', true);
    closeModal();
    await human('settings', { github_secret: secret }, 'GitHub connected: pull requests and CI will link to items');
  },
  'github-disconnect': async () => { closeModal(); await human('settings', { github_secret: '' }, 'GitHub disconnected'); },
  'notify-add': async () => {
    try {
      const mine = document.getElementById('nt-mine');
      await api('/api/notify', { method: 'POST', body: JSON.stringify({ kind: val('nt-kind'), url: val('nt-url'), ...(mine?.checked ? { person: S.notifyPerson } : {}) }) });
      toast('Channel added: send a test to check it');
      notifySettings();
    } catch (e) { toastError(e); }
  },
  'notify-weekly': async (el) => {
    try { await api('/api/notify/weekly', { method: 'POST', body: JSON.stringify({ id: Number(el.dataset.id), weekly: el.dataset.on === '1' }) }); notifySettings(); } catch (e) { toastError(e); }
  },
  'notify-remove': async (el) => {
    try { await api('/api/notify/remove', { method: 'POST', body: JSON.stringify({ id: Number(el.dataset.id) }) }); notifySettings(); } catch (e) { toastError(e); }
  },
  'notify-test': async () => {
    try {
      const r = await api('/api/notify/test', { method: 'POST' });
      toast(r.ok ? 'Test sent to every channel' : `Failed: ${r.results.filter((x) => !x.ok).map((x) => `${x.kind} (${x.error})`).join(', ')}`, !r.ok);
      notifySettings();
    } catch (e) { toastError(e); }
  },
  'new-project': () => newProject(),
  // Get started's "Link a project to its repository": that project, with its + repo form open.
  'link-repo': (el) => {
    if (el.dataset.slug === S.slug) return ACTIONS['remote-new']();
    setState({ linkRepo: el.dataset.slug });
    go(el.dataset.slug);
  },
  'get-started-hide': async () => {
    try { setState({ gs: await api('/api/get-started/hide', { method: 'POST' }) }); render({ force: true }); } catch (e) { toastError(e); }
  },
  'more-repos': (el) => { el.remove(); loadRepos(el.dataset.q, Number(el.dataset.page)); },
  'pick-repo': async (el) => {
    try {
      const r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ repo: el.dataset.repo, mission: el.dataset.desc }) });
      modal(`<h2>${esc(r.repo.replace('github.com/', ''))} is a project</h2>
        <p class="lead">Let <code>nuworq run</code> staff this project? It starts workers whenever there is work nobody is on, up to the limits it was started with. You can change this later in the project's settings.</p>
        <div class="foot"><button class="btn ghost" data-action="staff-new" data-runner="0" data-slug="${esc(r.slug)}">Not now</button><button class="btn primary" data-action="staff-new" data-slug="${esc(r.slug)}">Let run staff it</button></div>`);
    } catch (e) { toastError(e); }
  },
  'goto-new': (el) => { closeModal(); go(el.dataset.slug); },
  // Either answer is recorded, so the project page doesn't ask again (#174).
  'staff-new': async (el) => {
    try {
      await api(`/api/p/${encodeURIComponent(el.dataset.slug)}/human/settings`, { method: 'POST', body: JSON.stringify({ runner: el.dataset.runner !== '0' }) });
      closeModal();
      go(el.dataset.slug);
    } catch (e) { toastError(e); }
  },
  'close-modal': () => closeModal(),
  logout: async () => { await fetch('api/logout', { method: 'POST', credentials: 'same-origin' }); location.href = 'login.html'; },
  'first-project': async () => {
    const name = val('fp-name');
    if (!name) return toast('Name it', true);
    try {
      const remotes = val('fp-remotes').split(/[\s,]+/).filter(Boolean);
      const r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, mission: val('fp-mission'), remotes }) });
      clearDraft('fp-name', 'fp-mission', 'fp-remotes');
      await loadProjects();
      connectStep({ ...r, name });
    } catch (e) { toastError(e); }
  },
  'create-project': async () => {
    const name = val('np-name');
    if (!name) return toast('Name it', true);
    try {
      const r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, mission: val('np-mission'), remote: val('np-remote') || undefined }) });
      // Either answer is the answer (#491): the project page doesn't ask again.
      await api(`/api/p/${encodeURIComponent(r.slug)}/human/settings`, { method: 'POST', body: JSON.stringify({ runner: !!$('#np-staff')?.checked }) });
      closeModal();
      go(r.slug);
    } catch (e) { toastError(e); }
  },
  copy: async (el) => {
    if (await copyText(el.dataset.text)) return toast('Copied');
    // Refused every way: select the text, so the keyboard copies it.
    const pre = el.closest('.copyable')?.querySelector('pre');
    if (pre) getSelection().selectAllChildren(pre);
    toast(`This browser won't copy from a button: the text is selected, press ${/Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘C' : 'Ctrl-C'}`, true);
  },
};

// What each shortcut in SHORTCUTS (web/shortcuts.js) does; the two lists name the same ids.
export const KEYS = {
  launcher: (e) => { e.preventDefault(); ACTIONS.launcher(); },
  'ln-move': (e) => {
    e.preventDefault();
    const n = L.results.length;
    if (L.confirming || !n) return;
    L.sel = (L.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    drawLauncher({ keep: true });
  },
  'ln-run': (e) => { e.preventDefault(); runLauncher(L.confirming ?? L.results[L.sel]); },
  'ln-close': () => { if (L.confirming) { L.confirming = null; drawLauncher({ keep: true }); $('#ln-q')?.focus(); } else closeLauncher(); },
  help: () => { if ($('#modal .shortcuts')) closeModal(); else if ($('#modal').hidden) ACTIONS.shortcuts(); },
  close: () => closeModal(),
  // 1, 2, 3 set the depth everywhere: a project, and All projects.
  depth: (e) => {
    setZoom(Object.keys(Z)[Number(e.key) - 1]);
  },
  'leave-item': () => go(S.slug),
  send: () => ACTIONS['compose-send'](),
  press: (e) => {
    const btn = document.activeElement.parentElement?.querySelector('button[data-action]');
    if (btn) { e.preventDefault(); btn.click(); }
  },
  blur: () => document.activeElement.blur(),
};
