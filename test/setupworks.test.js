// The setup that works (#489): workers on nuworq run, an operator in a terminal, a shaper in the Claude Code app.
// Every place that says how to get going offers it in the same words and order, with the same commands.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SETUP, SETUP_LEAD, setupLine, setupSection } from '../web/connect.js';
import { commandsIn } from '../web/commands.js';
import { STEPS, SETUP_TITLE, guidePage, sessionLines } from '../src/userguide.js';
import { getStarted } from '../src/getstarted.js';
import { bare, GET_GOING, command } from '../src/help.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const unescape = (s) => s.replace(/&(lt|gt|quot|#39|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' })[e]);
// Where each text first appears, so a place can be checked for the order it names them in.
const order = (text, needles) => needles.map((n) => text.indexOf(n));
const ascending = (xs) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]));

describe('the setup that works, everywhere the same (#489)', () => {
  test('three sessions: workers, an operator, a shaper, each with what to type', () => {
    assert.deepEqual(SETUP.map((s) => s.key), ['workers', 'operator', 'shaper']);
    assert.deepEqual(SETUP.map((s) => s.title), ['Start workers', 'Start an operator', 'Shape work with a shaper']);
    assert.deepEqual(SETUP.map((s) => commandsIn(s.how)), [['nuworq run --install --workers auto'], ['claude', '/nuworq:operator'], ['/nuworq:shaper']]);
    assert.match(SETUP_LEAD, /how nuworq itself is built/);
    assert.match(SETUP_LEAD, /Starting with just a shaper is fine/);
  });

  // #646: the command first, then the form without the plugin; the copy block still copies the command alone.
  test('the operator and shaper lines name the command first, then the no-plugin form', () => {
    for (const k of ['operator', 'shaper']) {
      const s = SETUP.find((x) => x.key === k);
      assert.match(s.how, new RegExp(`type \`/nuworq:${k}\` \\(or "/nuworq-${k}" without the plugin\\)$`), k);
      assert.equal(commandsIn(s.how).at(-1), `/nuworq:${k}`);
      const lines = sessionLines(s);
      assert.equal(lines.at(-1), `(or "/nuworq-${k}" without the plugin)`, 'in the guide, a note after the command: no colon');
      assert.equal(lines.at(-2), `\`/nuworq:${k}\``);
      assert.match(lines.at(-3), /^Then type:$|type:$/, 'words before a command still lead into it');
    }
  });

  test('the guide: a section right after Install and connect your machine, each session in its words, with its commands to copy', () => {
    const i = STEPS.findIndex((s) => s.key === 'setup');
    assert.equal(STEPS[i - 1].key, 'machine');
    assert.equal(STEPS[i].title, SETUP_TITLE);
    assert.equal(STEPS[i].sessions, SETUP);
    const html = unescape(guidePage());
    const section = html.slice(html.indexOf('<details id="setup">'), html.indexOf('</details>', html.indexOf('<details id="setup">')));
    assert.ok(section.includes(SETUP_LEAD));
    assert.ok(ascending(order(section, SETUP.map((s) => `<h4 id="${s.key}">`))), 'in order');
    for (const s of SETUP) {
      assert.ok(section.includes(setupLine(s).replace(/`([^`]+)`/g, '<code>$1</code>')), `${s.key}: what, where and why`);
      for (const c of commandsIn(s.how)) assert.ok(section.includes(`data-copy="${c}"`), `${s.key}: ${c} to copy`);
    }
    for (const k of ['agent', 'plan']) {
      const step = STEPS.find((s) => s.key === k);
      assert.ok([...step.hand, step.auto].some((t) => t.includes(SETUP_TITLE)), `${k} points to ${SETUP_TITLE}`);
    }
  });

  test('Get started: the three steps after connecting the machine, in order and words', () => {
    const keys = getStarted({}).steps.map((s) => s.key);
    assert.deepEqual(keys.slice(keys.indexOf('machine') + 1, keys.indexOf('machine') + 4), SETUP.map((s) => s.key));
    assert.ok(!keys.includes('agent'), 'Start an agent is gone from Get started');
    for (const s of SETUP) assert.equal(getStarted({}).steps.find((x) => x.key === s.key).label, s.title);
  });

  test('Connect an agent: leads with the three, right after setting up the machine, each with its copy blocks', () => {
    const html = unescape(setupSection());
    assert.ok(html.includes(SETUP_TITLE) && html.includes(SETUP_LEAD));
    assert.ok(ascending(order(html, SETUP.map((s, k) => `<h4>${k + 1}. ${s.title}</h4>`))), 'in order');
    for (const s of SETUP) {
      assert.ok(html.includes(setupLine(s).replace(/`([^`]+)`/g, '<code>$1</code>')), s.key);
      for (const c of commandsIn(s.how)) assert.ok(html.includes(`data-text="${c}"`), `${s.key}: ${c} to copy`);
    }
    // In the dialog: after the machine's one paste, before nuworq up, and by hand only at depth 30m.
    const app = read('web/app.js');
    const dialog = app.slice(app.indexOf('async function connect()'), app.indexOf('async function notifySettings()'));
    assert.ok(ascending(order(dialog, ['Set up this machine (once)', '${setupSection()}', 'commandBlocks(c.up)', 'z() >= 2', 'commandBlocks(c.run)', 'OpenAI Codex', 'opencode'])), 'setup, the three, up, then by hand at 30m');
    // #644: one block to copy on the first screen; the three and nuworq up are folded beneath it, still copyable.
    const fold = dialog.indexOf('<details class="setup-fold"'), shut = dialog.indexOf('</details>', fold);
    assert.ok(fold > dialog.indexOf('commandBlocks(c.setup)'), 'after the one block');
    assert.ok(dialog.indexOf('${setupSection()}') > fold && dialog.indexOf('commandBlocks(c.up)') < shut, 'the three and nuworq up inside the fold');
    assert.match(dialog.slice(fold, shut), /<summary>.*What connect sets up, to do by hand.*<\/summary>/);
    assert.deepEqual(dialog.slice(0, fold).match(/commandBlocks\([^)]*\)/g), ['commandBlocks(c.setup)'], 'one block to copy before it');
  });

  test('the README opens its usage with the same setup, in the same words and order', () => {
    const readme = read('README.md');
    const usage = readme.slice(readme.indexOf('## 30 seconds'));
    assert.ok(usage.includes(`### ${SETUP_TITLE}`) && usage.includes(SETUP_LEAD));
    assert.ok(usage.indexOf(`### ${SETUP_TITLE}`) < usage.indexOf('nuworq up'), 'before the rest of the usage');
    assert.ok(ascending(order(usage, SETUP.map((s, k) => `${k + 1}. **${s.title}.** ${setupLine(s)}`))), 'each in its words, in order');
    for (const s of SETUP) for (const c of commandsIn(s.how)) assert.ok(usage.includes(c), `${s.key}: ${c}`);
  });

  test("the CLI's bare screen: Get going leads with connect, then the three, in order", () => {
    assert.deepEqual(GET_GOING.slice(0, 4), ['connect', 'run', 'operator', '/nuworq:shaper']);
    const screen = bare();
    const going = screen.slice(screen.indexOf('Get going'), screen.indexOf('Work with agents'));
    assert.ok(ascending(order(going, ['connect <hub>', ...SETUP.map((s) => s.title.charAt(0).toLowerCase() + s.title.slice(1))])), going);
    assert.ok(command('run').usage.some((u) => u.startsWith('run --install')), 'workers as a service: nuworq run --install');
    assert.ok(command('operator').flags.some(([f]) => f === '--start'), 'nuworq operator --start opens it');
  });
});
