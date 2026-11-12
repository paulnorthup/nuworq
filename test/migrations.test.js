// The database's schema moves by numbered migrations that run once and fail loudly, it has the indexes its queries
// need, and a request writes only what it must (#516).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, MIGRATIONS } from '../src/db.js';
import { Auth } from '../src/auth.js';
import { Hub } from '../src/core.js';

const fileDb = () => join(mkdtempSync(join(tmpdir(), 'nuworq-migrate-')), 'hub.db');
const version = (db) => db.prepare('PRAGMA user_version').get().user_version;
const indexes = (db) => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name);
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const NEW_INDEXES = ['questions_project', 'questions_item', 'notes_project', 'notes_item', 'prs_item', 'items_parent', 'items_holder',
  'items_fixes', 'items_implementer', 'events_type', 'events_actor', 'events_lapsed'];

describe('numbered migrations', () => {
  test('a fresh database runs every migration once and is at the last', () => {
    const db = openDb(fileDb());
    assert.equal(version(db), MIGRATIONS.length);
    for (const i of NEW_INDEXES) assert.ok(indexes(db).includes(i), i);
    assert.ok(columns(db, 'items').includes('notes_review'));
    assert.ok(columns(db, 'people').includes('verified_at'));
    assert.ok(columns(db, 'usage').includes('turns'), 'turns per run (#751)');
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1, 'WAL with synchronous=NORMAL');
    db.close();
  });

  test('a database at today\'s schema from before numbered migrations keeps its data and gains the indexes', () => {
    const file = fileDb();
    const hub = new Hub({ file });
    hub.tx(() => hub.project('old', { create: true }));
    hub.db.exec(`INSERT INTO agents (project_id, name, has, role, first_seen, last_seen) VALUES (1, 'op', '["operator"]', 'session', 0, 0)`);
    hub.db.close();
    // As a hub from before #516 left it: every column there, no version, none of the new indexes.
    const d = new DatabaseSync(file);
    for (const i of NEW_INDEXES) d.exec(`DROP INDEX ${i}`);
    d.exec('PRAGMA user_version = 0');
    d.close();
    const db = openDb(file);
    assert.equal(version(db), MIGRATIONS.length);
    for (const i of NEW_INDEXES) assert.ok(indexes(db).includes(i), i);
    assert.equal(db.prepare(`SELECT slug FROM projects`).get().slug, 'old');
    assert.equal(db.prepare(`SELECT role FROM agents WHERE name = 'op'`).get().role, 'operator', 'migration 1 backfills too');
    db.close();
  });

  test('a migration runs once: opening again changes nothing', () => {
    const file = fileDb();
    let runs = 0;
    const counted = [...MIGRATIONS, { name: 'count', up() { runs++; } }];
    openDb(file, { migrations: counted }).close();
    openDb(file, { migrations: counted }).close();
    assert.equal(runs, 1);
  });

  test('a migration that fails stops the start, names itself, and keeps none of its changes', () => {
    const file = fileDb();
    openDb(file).close();
    const broken = [...MIGRATIONS, {
      name: 'add a column and break',
      up(db) {
        db.exec('ALTER TABLE items ADD COLUMN half_done INTEGER');
        db.exec('ALTER TABLE no_such_table ADD COLUMN x INTEGER');
      },
    }];
    const n = MIGRATIONS.length + 1;
    assert.throws(() => openDb(file, { migrations: broken }),
      new RegExp(`Database migration ${n} \\(add a column and break\\) failed: .*no such table.*still at migration ${n - 1}`));
    const db = openDb(file);
    assert.equal(version(db), MIGRATIONS.length);
    assert.ok(!columns(db, 'items').includes('half_done'), 'rolled back');
    db.close();
  });

  test('migration 1 adds what an older database lacks and skips what it has', () => {
    const file = fileDb();
    const d = new DatabaseSync(file);
    d.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, seq INTEGER NOT NULL, title TEXT NOT NULL,
      stage TEXT NOT NULL, parent_id INTEGER, holder TEXT, implementer TEXT, created_by TEXT NOT NULL, stage_since INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      touching TEXT NOT NULL DEFAULT '[]')`);
    d.close();
    const db = openDb(file);
    assert.ok(columns(db, 'items').includes('race'), 'the missing columns were added');
    db.close();
  });
});

describe('names bound before #923 (#939)', () => {
  test("a session active before #923's migration stays closed to runner tokens", () => {
    const file = fileDb();
    const hub = new Hub({ file });
    hub.tx(() => hub.project('old', { create: true }));
    const add = (name, role, runner) => hub.db.prepare(`INSERT INTO agents (project_id, name, role, runner, first_seen, last_seen) VALUES (1, ?, ?, ?, 0, 0)`).run(name, role, runner);
    add('session', 'session', '');
    add('shaper', 'shaper', '');
    add('op', 'operator', '');
    add('worker', 'worker', 'mac');
    add('said-worker', 'worker', '');
    hub.db.close();
    // As a hub from before #923 left it: no by_person column, at the migration before it.
    const d = new DatabaseSync(file);
    d.exec('ALTER TABLE agents DROP COLUMN by_person');
    d.exec(`PRAGMA user_version = ${MIGRATIONS.findIndex((m) => m.name === 'an agent last active with a credential no runner shares')}`);
    d.close();
    const after = new Hub({ file });
    const marked = Object.fromEntries(after.q('SELECT name, by_person FROM agents').all().map((r) => [r.name, r.by_person]));
    assert.deepEqual(marked, { session: 1, shaper: 1, op: 1, worker: 0, 'said-worker': 0 });
    const runner = { name: 'runner:mac', runner: 'mac' };
    assert.throws(() => after.speaksAs('session', runner, null), /another agent's name/);
    assert.doesNotThrow(() => after.speaksAs('worker', runner, null), 'workers keep sharing the runner token');
    after.db.close();
  });
});

describe('model routing on by default (#723)', () => {
  test('the migration turns it on only where nobody turned it on or off', () => {
    const file = fileDb();
    const hub = new Hub({ file });
    hub.tx(() => ['never', 'off', 'onoff', 'fresh'].forEach((s) => hub.project(s, { create: true })));
    assert.equal(hub.q("SELECT model_routing FROM projects WHERE slug = 'fresh'").get().model_routing, 1, 'a new project routes');
    hub.humanOp('off', 'settings', { model_routing: false });
    hub.humanOp('onoff', 'settings', { model_routing: false });
    hub.humanOp('onoff', 'settings', { model_routing: true });
    hub.humanOp('onoff', 'settings', { model_routing: false });
    // As before #723: projects started off, and the choice was only in the headline.
    hub.db.exec("UPDATE projects SET model_routing = 0 WHERE slug != 'fresh'");
    hub.db.exec("UPDATE events SET data = '{}' WHERE type = 'runner'");
    hub.db.exec(`PRAGMA user_version = ${MIGRATIONS.findIndex((m) => m.name === 'model routing is on unless a person turned it off')}`);
    hub.db.close();
    const db = openDb(file);
    const on = Object.fromEntries(db.prepare('SELECT slug, model_routing FROM projects').all().map((r) => [r.slug, r.model_routing]));
    assert.deepEqual(on, { never: 1, off: 0, onoff: 0, fresh: 1 });
    db.close();
  });
});

describe('the queries find their rows by index', () => {
  test('lapsed leases by agent, events by type and actor, an item\'s children', () => {
    const db = openDb(':memory:');
    const plan = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');
    assert.match(plan(`SELECT COUNT(*) FROM events WHERE project_id = 1 AND type = 'lease_expired' AND json_extract(data, '$.agent') = 'a'`), /events_lapsed/);
    assert.match(plan(`SELECT COUNT(*) FROM events WHERE project_id = 1 AND actor = 'a'`), /events_actor/);
    assert.match(plan(`SELECT * FROM items WHERE parent_id = 3`), /items_parent/);
    assert.match(plan(`SELECT * FROM questions WHERE project_id = 1 AND status = 'open'`), /questions_project/);
    assert.match(plan(`SELECT * FROM prs WHERE item_id = 3`), /prs_item/);
  });
});

describe('a token\'s last-used time', () => {
  test('is written at most once a minute', () => {
    let now = 1_000_000;
    const auth = new Auth(openDb(':memory:'), { now: () => now });
    const token = auth.createToken('ci', 'agent');
    const used = () => auth.db.prepare(`SELECT last_used_at FROM tokens WHERE name = 'ci'`).get().last_used_at;
    assert.ok(auth.verifyToken(token));
    assert.equal(used(), 1_000_000);
    now += 59_000;
    assert.ok(auth.verifyToken(token));
    assert.equal(used(), 1_000_000, 'within the minute: no write');
    now += 1_000;
    assert.ok(auth.verifyToken(token));
    assert.equal(used(), 1_060_000);
  });
});
