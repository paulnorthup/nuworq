// A CI check as a chip (#192): passed is green with ✓, failed is red with ✗, anything else (pending, neutral,
// skipped) is plain with no mark and says what it is. Never both marks. Pure, so the page and the tests share it.
// What counts as failed is src/github.js's FAIL set.
const FAIL = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error']);

export const checkResult = (conclusion) => (conclusion === 'success' ? 'pass' : FAIL.has(conclusion) ? 'fail' : 'other');

// c: { name, conclusion, url? }. esc: the page's HTML escaper.
export function checkChip(c, esc) {
  const r = checkResult(c.conclusion);
  const label = `${{ pass: '✓ ', fail: '✗ ', other: '' }[r]}${esc(c.name)}${r === 'other' && c.conclusion ? `: ${esc(c.conclusion)}` : ''}`;
  return `<span class="ev check ${r}">${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${label}</a>` : label}</span>`;
}
