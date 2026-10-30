// Secrets don't belong in the record: whatever agents write is stored, shown and (hosted) held by
// a third party. These shapes are specific enough that git SHAs, UUIDs and hashes never match.
const SHAPES = [
  ['an AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  // Installation tokens are JWTs since October 2026: ghs_ and three base64url segments, so - _ and dots.
  ['a GitHub token', /\bgh[pousr]_(?:[A-Za-z0-9]{36,}\b|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/],
  ['a GitHub token', /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/],
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  // Project/service keys, or the legacy 48-character form (no dashes, so kebab-case prose never matches).
  ['an OpenAI API key', /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{32,}/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Slack webhook URL', /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/],
  ['a private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ['a nuworq token', /\b(?:nwq|trl)_[A-Za-z0-9_-]{40,}/], // trl_: tokens from before the rename
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
