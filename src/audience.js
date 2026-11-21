// Who answers a question: an operator first. An operator is a person's own session, acting with their
// access, so a person is asked only for what only a person can do, and the asker says which (ask's only_person).
// The hub can't check the reason, but it can make asking a person a stated claim, shown on the card, rather than
// the default. Everything else goes to an operator, which answers it, withdraws it or escalates it with a reason.
export const PERSON_ONLY = {
  'sign-in': 'their own sign-in: an account, credential, key or passkey only they hold (a CAPTCHA or a signature too)',
  money: 'spending or moving money',
  physical: 'being there in person: a device in hand, a cable, a screen only they can see',
  call: 'a product or priority call no decision covers: what to build, drop or ship, what matters most, what done means, or an irreversible step',
};
export const PERSON_REASONS = Object.keys(PERSON_ONLY);
// The same, as a card says it: "only a person: their sign-in".
export const PERSON_SHORT = { 'sign-in': 'their sign-in', money: 'money', physical: 'being there', call: 'a product call' };
// The rule in one line, for hints, the guide and the skills.
export const PERSON_RULE = 'Only a person can sign in as themselves (accounts, credentials, keys, passkeys), spend money, be there in person, or make a product or priority call no decision covers';
// Stored in questions.audience: 'operator', 'person:<reason>' (asked of a person, saying why), or '' (asked of a
// person before only_person existed, or by the hub itself: an operator may settle those too).
export const personAudience = (reason) => `person:${reason}`;
export const personReason = (audience) => (String(audience ?? '').startsWith('person:') ? String(audience).slice('person:'.length) : null);

// A question that asks the person to do something (not just decide) must come with numbered steps (the
// decision of 2026-10-30). Deterministic, no model call: a request aimed at the person, near a verb that is an action.
// A decision verb in between ("could you decide whether to add…") makes it a decision, not a request to act.
const ACT = String.raw`(create|add|install|set ?up|configure|enable|disable|turn (on|off)|click|tap|sign (in|up)|log ?in|run|paste|copy|grant|invite|connect|rotate|upload|merge|register|generate|go to|visit|authori[sz]e|restart)`;
const DECIDE = String.raw`\b(decide|choose|pick|confirm|approve|prefer|agree|ok|okay)\b`;
const REQUEST = new RegExp(String.raw`\b(can you|could you|would you|will you|please|you need to|you'?ll need to|you have to|you must|needs? you to|need you to|ask(ing)? you to)\b(?:(?!${DECIDE}).){0,60}?\b${ACT}\b`);
const IMPERATIVE = new RegExp(String.raw`^(please )?${ACT}\b`);

export function needsSteps({ question = '', context = '' } = {}) {
  const q = question.trim().toLowerCase();
  return IMPERATIVE.test(q) || REQUEST.test(`${q}\n${context.toLowerCase()}`);
}
