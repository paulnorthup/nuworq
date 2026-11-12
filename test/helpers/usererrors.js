// Finds every `new UserError(` call in src and returns those that pass no hint.
import fs from 'node:fs';
import path from 'node:path';

// Index just past the string or template literal that starts at s[i]; templates may nest `${ ... }` with strings inside.
function skipQuoted(s, i) {
  const q = s[i];
  for (i++; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === q) return i + 1;
    else if (q === '`' && c === '$' && s[i + 1] === '{') i = skipBraces(s, i + 2) - 1;
  }
  return i;
}
// Index just past the `}` closing an expression that starts at s[i].
function skipBraces(s, i) {
  for (let depth = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') i = skipQuoted(s, i) - 1;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return i;
}

export function hintlessUserErrors(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    let i = 0;
    while ((i = s.indexOf('new UserError(', i)) >= 0) {
      let j = i + 14;
      for (let depth = 1; j < s.length && depth > 0; j++) {
        const c = s[j];
        if (c === '"' || c === "'" || c === '`') j = skipQuoted(s, j) - 1;
        else if (c === '(') depth++;
        else if (c === ')') depth--;
      }
      const call = s.slice(i, j);
      if (!/hint/.test(call)) {
        out.push({ file: f, line: s.slice(0, i).split('\n').length, call: call.replace(/\s+/g, ' ') });
      }
      i = j;
    }
  }
  return out;
}
