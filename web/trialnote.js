// Staffing (#725): a model trial needs a tier to step down to, so a kind with fewer than two models listed never
// gets one. Say so beside the setting rather than let the share do nothing. Pure: the numbers and lists are passed in.
const listed = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);

// trial: the share of building jobs; tiers: { claude: 'a, b' | ['a', 'b'], ... }; defaults: the tiers an agent left
// blank uses (#723, Claude's three). Returns the line, or '' when trials can run (routing off, share 0, or some
// agent kind has two or more models, its own or the default ones).
export function trialNote({ on, trial, tiers, defaults = {} }) {
  if (!on || !(Number(trial) > 0)) return '';
  const agents = new Set([...Object.keys(tiers ?? {}), ...Object.keys(defaults)]);
  if ([...agents].some((a) => (listed(tiers?.[a]).length ? listed(tiers[a]) : listed(defaults[a])).length >= 2)) return '';
  return 'Trials need two or more models, cheapest first. Add a cheaper Claude model above to start them.';
}
