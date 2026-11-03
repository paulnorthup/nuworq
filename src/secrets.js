// Installation tokens are JWTs since October 2026: ghs_ and three base64url segments, so - _ and dots.
// A regex for that scans to the end of the run from every gh?_ inside it, which is quadratic in the run's
// length (#780). Instead each run of token characters is split on its dots, and each segment is looked at
// once: three adjacent segments of 10 or more make a token when the first has gh?_ (at its start or after
// a dash) and 10 more characters. It answers test() and match() like a regex (scripts/scan-history.js).
const githubJwt = {
  exec(text) {
    for (const run of text.matchAll(/[\w.-]{36,}/g)) {
      const seg = run[0].split('.');
      for (let i = 0, at = run.index; i + 2 < seg.length; at += seg[i].length + 1, i++) {
        if (seg[i + 1].length < 10 || seg[i + 2].length < 10) continue;
        const m = /(?:^|-)gh[pousr]_[\w-]{10}/.exec(seg[i]);
        if (!m) continue;
        const start = at + m.index + (m[0][0] === '-' ? 1 : 0);
        const end = at + seg[i].length + seg[i + 1].length + seg[i + 2].length + 2;
        return Object.assign([text.slice(start, end)], { index: start });
      }
    }
    return null;
  },
  test(text) { return this.exec(text) !== null; },
  [Symbol.match](text) { return this.exec(text); },
};

// Secrets don't belong in the record: whatever agents write is stored, shown and (hosted) held by
// a third party. These shapes are specific enough that git SHAs, UUIDs and hashes never match.
// Each is checked in time linear in the text, however it's shaped: the check runs on every write.
export const SHAPES = [
  ['an AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['a GitHub token', githubJwt],
  ['a GitHub token', /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/],
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  // Project/service keys, or the legacy 48-character form (no dashes, so kebab-case prose never matches).
  ['an OpenAI API key', /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{32,}/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Slack webhook URL', /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/],
  ['a private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ['a nuworq token', /\bnwq_[A-Za-z0-9_-]{40,}/],
  ['a bearer token', /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
];

// The first secret anywhere in a value (strings, arrays, objects): where it is and what it looks like.
// Never returns the secret itself.
export function findSecret(value, path = '') {
  if (typeof value === 'string') {
    for (const [kind, re] of SHAPES) if (re.test(value)) return { path: path || 'text', kind };
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findSecret(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const hit = findSecret(v, path ? `${path}.${k}` : k);
      if (hit) return hit;
    }
  }
  return null;
}
