// A timeline dot's color (#194): whose move the item became after the event, in the lifecycle bar's tokens, so the
// timeline agrees with the bar right above it. 'verifying' and 'proposed' take the project's court for that stage
// (it depends on autonomy). '' is a plain dot: the event changes nobody's move. Every event type the hub records
// is listed (test/court.test.js fails on a new one), project-level ones too, so nothing falls back by accident.
export const DOT = {
  // agents are on it
  claimed: 'agents', progress: 'agents', landing: 'agents', accepted: 'agents', shaping: 'agents', review_started: 'agents',
  rebased: 'agents', pushed: 'agents', pr: 'agents', pr_blocked: 'agents', assumption: 'agents', assumption_confirmed: 'agents',
  // the person's move
  question: 'you', kept_parked: 'you',
  // back in the queue for any agent
  answered: 'queue', sent_back: 'queue', handoff: 'queue', unparked: 'queue', race_finished: 'queue', precondition_passed: 'queue',
  // depends on the project's autonomy
  submitted: 'verifying', shaped: 'proposed',
  // finished, at risk, failed
  landed: 'ok', lease_expired: 'warn', pr_failed: 'bad', pr_merge_failed: 'bad', issue_close_failed: 'bad', credential_refused: 'bad',
  // notes and bookkeeping: nobody's move changes
  comment: '', created: '', refined: '', regrouped: '', tidied: '', not_chosen: '', question_withdrawn: '', staged: '', check_now: '',
  alert: '', issue: '', duplicate: '', stale: '', ci: '', retired: '', restored: '', learned: '', ack: '', picked: '', stewards: '',
  checkin: '', signoff: '', project: '', path: '', remote: '', runner: '', settings: '', github: '', github_app: '', parked: '',
  mission: '', joined: '', connected: '', credential: '',
};

// courtOf(stage): the project's court for a stage (agents, queue, you, external, or null).
export function dotClass(type, courtOf) {
  let c = DOT[type] ?? '';
  if (c === 'verifying') c = courtOf('verifying') ?? '';
  if (c === 'proposed') c = courtOf('proposed') === 'you' ? 'you' : 'queue'; // shaped: ready, or yours to approve under "ask"
  return c ? `c-${c}` : '';
}
