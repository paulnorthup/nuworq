// Live updates at a calm pace (#392). The hub can send a burst of changes (an agent posting progress, a review, a
// land): they become at most one update a second. And none lands under the person's hand: while they're scrolling
// or holding a pointer on something, updates wait, then apply once they let go.
// One update at a time (#502): while one is on its way, more changes make exactly one more once it's back.
// Pure but for the timers passed in, so it's tested with a fake clock.

export function liveGate({ run, idle = () => {}, gap = 1000, gather = 150, quiet = 250, now = () => Date.now(), timers = globalThis } = {}) {
  let last = -Infinity, timer = null, held = false, still = 0, waiting = false, quietTimer = null, flying = false, again = false;
  const busy = () => held || now() < still;
  const schedule = () => {
    if (flying) { again = true; return; }
    if (timer) return;
    // A moment to gather the rest of a burst, and never sooner than a second after the last update.
    timer = timers.setTimeout(fire, Math.max(gather, last + gap - now()));
  };
  function fire() {
    timer = null;
    if (busy()) { waiting = true; return; } // let go, and it runs
    last = now();
    flying = true;
    const landed = () => { flying = false; if (again) { again = false; schedule(); } };
    let out;
    try { out = run(); } catch { return landed(); }
    if (out && typeof out.then === 'function') out.then(landed, landed); else landed();
  }
  const settled = () => {
    if (held) return;
    if (now() < still) { quietTimer = timers.setTimeout(settled, still - now()); return; }
    if (waiting) { waiting = false; schedule(); }
    idle();
  };
  return {
    busy,
    // The hub changed (or it's time to look again).
    poke: schedule,
    // A pointer went down on the page, and came up again.
    press() { held = true; },
    release() { held = false; settled(); },
    // The page, or something in it, scrolled: updates wait until it's been still a moment.
    scrolled() {
      still = now() + quiet;
      timers.clearTimeout(quietTimer);
      quietTimer = timers.setTimeout(settled, quiet);
    },
  };
}

// Whether a change the hub streams (#502: { project, item, items }, as JSON) is in what's on screen. slug: the
// project page shown, or null for a screen of every project (the home, analytics), where every change is.
// A change about no project (runners, channels) is everyone's.
export function onScreen(data, { slug = null } = {}) {
  let e;
  try { e = JSON.parse(data); } catch { return true; }
  return !slug || !e?.project || e.project === slug;
}
