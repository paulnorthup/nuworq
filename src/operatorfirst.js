// What an operator settles before a person hears of it: a card the hub works out from the board rather than from
// a question (today "no agent working", when an operator is here and it isn't a runner out of budget) goes to an
// operator as the hub's own operator question. insight.js shows people that card only as worth knowing (to:
// 'operator'), so it never reaches Needs you or a push. Asked once per 6 hours while the card stands, and withdrawn
// when it goes. The operator answers with what it did (started a runner, found why it skips), or escalates with
// only_person when only a person can fix it (the machine is off: "physical"). Runs from the hub's sweep.
import { view } from './insight.js';
import { SYSTEM, HOUR, LIMITS } from './core.js';

export const STAFF_ASK = 'No agent is working here';
const AGAIN = 6 * HOUR; // the no-agents card's own window

const openAsk = (hub, p) => hub.q(`SELECT * FROM questions WHERE project_id = ? AND asked_by = ? AND audience = 'operator' AND status = 'open' AND question LIKE ? ORDER BY id DESC LIMIT 1`)
  .get(p.id, SYSTEM, `${STAFF_ASK}%`) ?? null;

export function operatorFirst(hub) {
  const t = hub.now();
  for (const p of hub.projects()) {
    if (p.parked) continue;
    const card = view(hub, p.slug, { light: true, operator: true }).attention.find((a) => a.kind === 'no-agents' && a.to === 'operator');
    const open = openAsk(hub, p);
    if (!card) {
      if (open) withdraw(hub, p, open, 'agents are working again, or there is no work for them');
      continue;
    }
    if (open) continue;
    if (hub.q(`SELECT 1 FROM questions WHERE project_id = ? AND asked_by = ? AND audience = 'operator' AND question LIKE ? AND at > ?`).get(p.id, SYSTEM, `${STAFF_ASK}%`, t - AGAIN)) continue;
    if (hub.q(`SELECT COUNT(*) AS n FROM questions WHERE project_id = ? AND status = 'open'`).get(p.id).n >= LIMITS.openQuestions) continue;
    const question = `${STAFF_ASK}: ${card.headline}`;
    const steps = (card.how ?? []).map((s, i) => `${i + 1}. ${s.do}${s.where ? `: ${s.where}` : ''}${s.check ? ` (check: ${s.check})` : ''}`).join('\n');
    const context = [
      card.sub, card.why, steps && `What starts it again:\n${steps}`,
      'Start or fix what stops the workers, then answer with what you did. Nothing is parked on this; the hub asks again in 6 hours if no agent is working by then. Escalate (only_person) only what only a person can do, such as a machine that is off ("physical") or a budget ("money").',
    ].filter(Boolean).join('\n\n');
    const id = Number(hub.q(`INSERT INTO questions (project_id, item_id, asked_by, question, context, options, blocking, assumption, at, audience, evidence, steps)
      VALUES (?, NULL, ?, ?, ?, '[]', 1, '', ?, 'operator', '[]', '[]')`).run(p.id, SYSTEM, question, context, t).lastInsertRowid);
    hub.event(p, { actor: SYSTEM, type: 'question', headline: `nuworq asks an operator: ${question}`, summary: context, data: { question: id, cause: card.cause } });
  }
}

function withdraw(hub, p, q, why) {
  hub.q(`UPDATE questions SET status = 'withdrawn', closed_reason = ?, held_by = '', held_until = 0 WHERE id = ?`).run(why, q.id);
  hub.q(`UPDATE questions SET status = 'withdrawn', closed_reason = ? WHERE escalates = ? AND status = 'open'`).run(why, q.id);
  hub.event(p, { actor: SYSTEM, type: 'question_withdrawn', headline: `nuworq withdrew its question: ${why}`, summary: `Why: ${why}`, data: { question: q.id } });
}
