// Staffing (#725): a model trial needs a tier to step down to, so a kind with fewer than two models listed never
// gets one. Say so beside the setting rather than let the share do nothing. Pure: the numbers and lists are passed in.
const listed = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);

// trial: the share of building jobs; tiers: { claude: 'a, b' | ['a', 'b'], ... }. Returns the line, or '' when
// trials can run (routing off, share 0, or some agent kind has two or more models listed).
export function trialNote({ on, trial, tiers }) {
  if (!on || !(Number(trial) > 0)) return '';
  if (Object.values(tiers ?? {}).some((v) => listed(v).length >= 2)) return '';
  return 'Trials need two or more models, cheapest first. Add a cheaper Claude model above to start them.';
}
