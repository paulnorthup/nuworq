import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { commandParts, commandsIn } from '../web/commands.js';
import { commandBlocks } from '../web/copy.js';
import { connectCommands } from '../web/connect.js';
import { Hub } from '../src/core.js';
import { view } from '../src/insight.js';
import { tools } from '../src/protocol.js';

// #379: every command a person is asked to run copies clean, one Copy each.
// What each Copy button would put on the clipboard, in order, and the words shown between them.
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const copied = (html) => [...html.matchAll(/data-text="([^"]*)"/g)].map((m) => unesc(m[1]));
const joins = (html) => [...html.matchAll(/<p class="cmd-join">([^<]*)<\/p>/g)].map((m) => unesc(m[1]));

describe('a where as clean commands', () => {
  test('one bare command copies as it is', () => {
    assert.deepEqual(commandParts('nuworq connect https://app.nuworq.com'), [{ cmd: 'nuworq connect https://app.nuworq.com' }]);
    assert.deepEqual(copied(commandBlocks('ls -t ~/.nuworq/logs | head')), ['ls -t ~/.nuworq/logs | head']);
  });

  test('a backticked command copies without its backticks, or a prompt', () => {
    assert.deepEqual(copied(commandBlocks('`nuworq connect https://app.nuworq.com`')), ['nuworq connect https://app.nuworq.com']);
    assert.deepEqual(copied(commandBlocks('``echo `date` ``')), ['echo `date`']);
    assert.deepEqual(copied(commandBlocks('$ npm test')), ['npm test']);
  });

  test('several commands get a Copy each, in order, with the joining words between them as plain text', () => {
    const html = commandBlocks('`git fetch origin` then `git rebase origin/main`, and `npm test`.');
    assert.deepEqual(copied(html), ['git fetch origin', 'git rebase origin/main', 'npm test']);
    assert.deepEqual(joins(html), ['then', 'and']);
    assert.ok(html.indexOf('git fetch origin') < html.indexOf('then') && html.indexOf('then') < html.indexOf('git rebase'));
    assert.deepEqual(commandParts('Run `make` in the repo'), [{ text: 'Run' }, { cmd: 'make' }, { text: 'in the repo' }]);
  });

  test('a fenced multi-line block is one command per line; a \\ continues, # is a comment', () => {
    const where = '```sh\n$ cd ~/nuworq\n# then build\nnpm ci \\\n  --omit=dev\n\nnpm test\n```';
    const html = commandBlocks(where);
    assert.deepEqual(copied(html), ['cd ~/nuworq', 'npm ci \\\n  --omit=dev', 'npm test']);
    assert.deepEqual(joins(html), ['then build']);
    assert.deepEqual(commandsIn('nuworq stop\nnuworq run'), ['nuworq stop', 'nuworq run']);
  });

  test('prose with no command stays as it was; nothing copies backticks', () => {
    assert.deepEqual(commandParts("the repo's Settings page"), [{ cmd: "the repo's Settings page" }]);
    assert.equal(commandBlocks(''), '');
    for (const w of ['`a` then `b`', '```\nx\n```', '`y`']) assert.ok(copied(commandBlocks(w)).every((c) => !c.includes('```') && !/^`|`$/.test(c)));
  });

  test("Connect's plugin install is two commands, each with its own Copy", () => {
    const c = connectCommands({ url: 'https://app.nuworq.com' });
    assert.deepEqual(copied(commandBlocks(c.plugin)), ['claude plugin marketplace add paulnorthup/nuworq#release','claude plugin install nuworq@nuworq --scope user']);
  });
});

describe('the hub tidies steps on the way in', () => {
  function setup() {
    const hub = new Hub({ clock: () => Date.UTC(2026, 9, 31, 9) });
    hub.tx(() => hub.project('o', { create: true }));
    hub.humanOp('o', 'create', { title: 'Connect the VM', acceptance: 'x' });
    hub.agentOp('o', 'checkin', 'w1', {});
    hub.agentOp('o', 'claim', 'w1', { item: '#1' });
    const ask = (steps) => hub.agentOp('o', 'ask', 'w1', { item: '#1', blocking: true, to: 'human', question: 'Can you connect the VM?', steps });
    return { ask, steps: () => view(hub, 'o').attention.find((a) => a.kind === 'question').steps };
  }

  test('one wrapped command loses its backticks, and the hint says so', () => {
    const { ask, steps } = setup();
    const r = ask([{ do: 'Connect it', where: '`nuworq connect https://app.nuworq.com`' }, { do: 'Open it', where: 'https://app.nuworq.com' }]);
    assert.deepEqual(steps().map((s) => s.where), ['nuworq connect https://app.nuworq.com', 'https://app.nuworq.com']);
    assert.match(r.hint, /Tidied your steps: step 1: took the backticks/);
    assert.match(r.hint, /no backticks/);
  });

  test('several commands are split, in order; where keeps the joining words for display', () => {
    const { ask, steps } = setup();
    const r = ask([{ do: 'Update it', where: '`git fetch` then `git rebase origin/main`' }]);
    const [s] = steps();
    assert.deepEqual(s.commands, ['git fetch', 'git rebase origin/main']);
    assert.deepEqual(joins(commandBlocks(s.where)), ['then']);
    assert.match(r.hint, /step 1: split its where into 2 commands/);
  });

  test('clean steps pass untouched, with no tidy note', () => {
    const { ask, steps } = setup();
    const r = ask([{ do: 'Connect it', where: 'nuworq connect https://app.nuworq.com', check: 'It says connected' }]);
    assert.deepEqual(steps(), [{ do: 'Connect it', where: 'nuworq connect https://app.nuworq.com', check: 'It says connected' }]);
    assert.doesNotMatch(r.hint, /Tidied/);
  });

  test('the steps schema says where is a URL or one command, with no backticks', () => {
    const ask = tools().find((t) => t.name === 'ask');
    assert.match(ask.inputSchema.properties.steps.items.properties.where.description, /one command.*no backticks/);
  });
});
