// What nuworq connect asks once it is connected (#490): staff the project with workers on this machine, and
// start an operator, one question at a time. Each says what it does and costs; a no prints the command for
// later. It ends with how to start a shaper. The I/O is passed in (ask, say, actions), so tests answer it.
// mode: 'ask' with a person at the terminal; 'yes' or 'no' (--yes, --no, or no terminal: 'no') answers every
// question without asking. Nothing is installed or opted in without a yes.

export const BUDGET = 20; // dollars a day: the cap a person accepts or types over

// A yes/no question, or the mode's answer. def: what Enter means.
export function answerer(mode, ask) {
  return async (question, { def = false } = {}) => {
    if (mode !== 'ask') return mode === 'yes';
    const said = String(await ask(`${question} ${def ? '[Y/n]' : '[y/N]'} `) ?? '').trim();
    return said ? /^y(es)?$/i.test(said) : def;
  };
}

// The daily cap: typed, or the default on Enter. Asked again once when it isn't a number of dollars.
export async function budgetOf(mode, ask, given) {
  const n = (v) => { const x = Number(String(v ?? '').trim().replace(/^\$/, '')); return x > 0 ? Math.round(x * 100) / 100 : null; };
  if (given !== undefined && given !== true) return n(given) ?? BUDGET;
  if (mode !== 'ask') return BUDGET;
  for (let i = 0; i < 2; i++) {
    const said = String(await ask(`Daily spending cap for its workers, in dollars [${BUDGET}]: `) ?? '').trim();
    if (!said) return BUDGET;
    if (n(said)) return n(said);
  }
  return BUDGET;
}

// The project this setup is for: --project, else the one whose repository this folder is a clone of, else
// (asked) one from the list. Returns { project, folder } where folder is null when it isn't cloned here yet,
// or { none } with why there isn't one.
export async function chooseProject({ projects, named, remote, root, mode, ask, say }) {
  const live = projects.filter((p) => !p.parked);
  // A clone of its repository, or (a hub on this machine) the folder it lives in.
  const isHere = (p) => !!root && ((!!remote && (p.remotes ?? []).includes(remote)) || p.path === root);
  if (named) {
    const p = live.find((x) => x.slug === named || x.name === named);
    if (!p) return { none: `The hub has no project "${named}".` };
    return { project: p, folder: isHere(p) ? root : null };
  }
  const here = live.find(isHere);
  if (here) return { project: here, folder: root };
  if (!live.length) return { none: 'The hub has no projects yet: add one on the hub (+ Project), then connect again from its clone.' };
  if (live.length === 1) return { project: live[0], folder: null };
  if (mode !== 'ask') return { none: 'This folder is no clone of a project on the hub: connect again from a clone, or pass --project <slug>.' };
  say(`This folder is no clone of a project on the hub. Which project is this machine for?`);
  live.forEach((p, i) => say(`  ${i + 1}. ${p.name ?? p.slug}`));
  const said = String(await ask(`Project [1-${live.length}, Enter for none]: `) ?? '').trim();
  const p = live[Number(said) - 1];
  return p ? { project: p, folder: null } : { none: 'No project chosen: connect again from a clone of one, or pass --project <slug>.' };
}

// The questions, in order. project: { slug, name, runner } (runner: already staffed); folder: its clone here, or null with clone: the command that
// makes it. plugin: whether Claude Code has the nuworq plugin (its commands are /nuworq:…, else /nuworq-…).
// actions: staff(project, budget) and installRunner() return lines to print; startOperator() hands the terminal
// to Claude Code (last, as it returns only when the session ends). Returns what was done: { staffed, operator }.
export async function finishSetup({ mode, ask, say, project, folder, clone, plugin, budget, actions }) {
  const yes = answerer(mode, ask);
  const name = project.name ?? project.slug;
  const out = { staffed: false, operator: false };
  if (!folder && clone) say(`${name} isn't cloned on this machine. Clone it with: ${clone}`);

  // 2. Workers on this machine. Already staffed (#643): said, not asked again; this machine's runner is one command.
  if (project.runner) {
    say(`${name} is already staffed: nuworq run starts its workers. To run them on this machine too: nuworq run --install   (in ${folder ?? 'its clone'})`);
  } else if (await yes(`Staff ${name} with workers on this machine? It turns on staffing for ${name} and installs nuworq run as a background service, which starts Claude Code workers on waiting work, also after a reboot. They spend on your Claude account, up to a daily cap you set next.`)) {
    const usd = await budgetOf(mode, ask, budget);
    try {
      for (const l of await actions.staff(project, usd)) say(l);
      for (const l of await actions.installRunner()) say(l);
      out.staffed = true;
    } catch (e) {
      say(`Couldn't staff ${name}: ${e.message}${e.hint ? ` (${e.hint})` : ''}`);
      say(`Later: nuworq staff ${project.slug} --budget ${usd}`);
    }
  } else {
    say(`Later: nuworq staff ${project.slug}   (in ${folder ?? 'its clone'})`);
  }

  // 3. An operator, in a terminal: needs the clone to open in.
  const op = plugin ? '/nuworq:operator' : '/nuworq-operator';
  if (!folder) {
    say(`Once it's cloned: cd into it and run nuworq operator --start, to start an operator.`);
  } else if (await yes(`Start an operator now? It opens Claude Code in ${folder} with ${op}: an attended session with your permissions that answers agents' questions, reviews and lands work. It uses your Claude account while there's work, and waits for free when there's none.`)) {
    out.operator = true;
  } else {
    say(`Later: nuworq operator --start   (in ${folder})`);
  }

  // The shaper, for planning with a person: the desktop app, in the project's folder.
  say(`Last, to plan work with a shaper: open ${folder ?? `${name}'s clone`} in the Claude Code app and type ${plugin ? '/nuworq:shaper' : '/nuworq-shaper'}.`);
  // From then on (#559): one command brings the runner and every project's operator up, again after a restart.
  say(`From now on, and after any restart: nuworq up keeps the runner going and an operator open for each project that isn't parked.`);
  if (out.operator) await actions.startOperator();
  return out;
}
