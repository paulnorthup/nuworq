// Staffing (#770): what turning on cheaper models does, as src/models.js routes. Building starts on the top model and
// moves down only once results say a cheaper one meets the bar; a share of builds tries one down; rote jobs start on
// the cheapest; reviews and shaping never move. Pure: the bar and shares are passed in.
export const MIN_ATTEMPTS = 20; // src/models.js MIN_ATTEMPTS; test/routingconfirm.test.js keeps them equal

// quality: { label, means } of the chosen bar; trial, race: the shares of building jobs, whole percents.
export function routingConfirm({ quality, trial = 10, race = 0 } = {}) {
  const bar = quality ? `your quality bar, ${quality.label}: ${quality.means}` : 'your quality bar';
  const shares = [
    Number(trial) > 0 ? `${Number(trial)}% of builds try one model down` : '',
    Number(race) > 0 ? `${Number(race)}% race a cheaper model against the top one` : '',
  ].filter(Boolean);
  return 'Turn on cheaper models?\n\n'
    + 'Building starts on the top model listed (Claude\'s default ones if you set none, else the runner\'s --model). '
    + `Once the top model and a cheaper one each have ${MIN_ATTEMPTS} finished attempts at a kind of job, it moves to the cheapest model within ${bar}. `
    + (shares.length ? `${shares.join(', and ')}, to learn what each can do. ` : '')
    + 'Landing and tidying start on the cheapest model. Reviews and shaping stay on the top model.\n\n'
    + 'When an attempt is sent back, stalls, is handed off or loses its lease, that item\'s next attempt steps up one model. Each routed worker does one job, then stops.\n\n'
    + 'Turn it off any time from here.';
}
