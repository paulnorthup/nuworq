// Who answers a question when the asker leaves out `to`. Deterministic, no model call: a question about
// running things, permissions, credentials, infrastructure or verifying on a real system goes to an
// operator (a trusted, attended session); direction, scope, money, publishing, deleting, or anything we
// can't place stays with the human. The human signals win, so a mixed question errs toward the human.

const HUMAN = [
  [/\b(prioriti[sz]e|priority|priorities|scope|direction|roadmap|strategy|worth (it|doing|building))\b/, 'scope or direction'],
  [/\b(should (we|i|it)|do you want|would you (like|prefer)|prefer|which|or not|decide|decision|policy|ok with|okay with)\b/, 'a decision'],
  [/\bapprove\b/, 'an approval only the human gives'],
  [/(\$\d|\b(money|price|pricing|cost|costs|budget|pay|paid|spend|billing|invoice|plan tier)\b)/, 'money'],
  [/\b(publish|publicly|announce|launch (it|this|publicly)|go public|release notes|blog|tweet)\b/, 'publishing'],
  [/\b(delete|deleting|deletion|remove|drop|wipe|purge|archive|force[- ]push)\b/, 'deleting something'],
];

const OPERATOR = [
  [/`[^`]+`/, 'a command'],
  [/\b(run|running|execute|launch|invoke|install)\b.{0,40}\b(command|cli|script|binary|tests? (on|against)|live|migration|locally|headless)\b/, 'running a command'],
  [/\b(approval|permission|permissions|allowlist|sudo|settings\.json|grant|granted)\b/, 'permissions'],
  [/\b(credential|credentials|token|tokens|secret|secrets|api key|ssh key|password|keychain|oauth app)\b/, 'credentials'],
  [/\b(server|servers|vm|vms|virtual machine|dns|domain|deploy|deployed|deployment|infra|infrastructure|prod|production|staging|hosting|tls|certificate|firewall|port \d+)\b/, 'infrastructure'],
  [/\b(github app|admin|webhook|installation)\b/, 'the GitHub App or admin access'],
  [/\b(verify|check|confirm|test|reproduce)\b.{0,40}\b(real|live|actual)\b/, 'verifying on a real system'],
];

// { audience: 'operator' | 'human', reason } for a question (and its context) asked without `to`.
export function defaultAudience({ question = '', context = '' } = {}) {
  const text = `${question}\n${context}`.toLowerCase();
  for (const [re, why] of HUMAN) if (re.test(text)) return { audience: 'human', reason: `it is about ${why}` };
  for (const [re, why] of OPERATOR) if (re.test(text)) return { audience: 'operator', reason: `it is about ${why}` };
  return { audience: 'human', reason: 'nothing marks it as running things, permissions or infra' };
}
