// Live updates at a calm pace (#392). The hub can send a burst of changes (an agent posting progress, a review, a
// land): they become at most one update a second. And none lands under the person's hand: while they're scrolling
// or holding a pointer on something, updates wait, then apply once they let go.
// Nor does one start while the last is still on its way, or while the tab is hidden (#517): it runs once after.
// Pure but for the timers passed in, so it's tested with a fake clock.

export function liveGate({ run, idle = () => {}, hidden = () => false, gap = 1000, gather = 150, quiet = 250, now = () => Date.now(), timers = globalThis } = {}) {
  let last = -Infinity, timer = null, held = false, still = 0, waiting = false, quietTimer = null, inflight = false;
  const busy = () => held || now() < still;
  const schedule = () => {
    if (timer) return;
    // A moment to gather the rest of a burst, and never sooner than a second after the last update.
    timer = timers.setTimeout(fire, Math.max(gather, last + gap - now()));
  };
  function fire() {
    timer = null;
    if (busy() || inflight || hidden()) { waiting = true; return; } // let go, it lands, or it's shown: then it runs
    last = now();
    const r = run();
    if (!r?.finally) return;
    inflight = true;
    r.catch(() => {}).finally(() => {
      inflight = false;
      if (waiting && !busy()) { waiting = false; schedule(); }
    });
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
    // The tab is shown again: what changed while it was hidden comes in once.
    shown() { if (waiting && !busy() && !hidden()) { waiting = false; schedule(); } },
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
