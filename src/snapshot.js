// One load of a project's live state (#538): its items, dependencies, the jobs its agents hold and the per-agent
// counts the project page shows, each read once with a few whole-project queries and kept in maps, instead of a
// query per item or per agent. Each part loads the first time something asks for it.
//
// A snapshot lasts until the database changes: hub.snap(p) checks SQLite's change counters (this connection's
// total_changes() and data_version, which moves when another connection commits) on every call, and builds a new
// one when either moved. So whatever reads it sees exactly what a query would have, and a run of reads with no
// write between them (a view, checkin, next, route) shares one load.

const json = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

export class Snapshot {
  constructor(hub, projectId, version) {
    this.hub = hub;
    this.id = projectId;
    this.version = version;
    this.parts = new Map();
  }

  // A part, loaded once.
  part(name, load) {
    if (!this.parts.has(name)) this.parts.set(name, load());
    return this.parts.get(name);
  }

  // Every item in the project, by seq.
  get items() {
    return this.part('items', () => this.hub.q('SELECT * FROM items WHERE project_id = ? ORDER BY seq').all(this.id));
  }

  get byId() {
    return this.part('byId', () => new Map(this.items.map((i) => [i.id, i])));
  }

  // What must finish first, per item id (core.js unmetDeps): its open dependencies by seq, then its open
  // children by seq that aren't dependencies too.
  unmetOf(item) {
    const unmet = this.part('unmet', () => {
      const open = (i) => i && !['done', 'dropped'].includes(i.stage);
      const deps = new Map(), kids = new Map();
      for (const d of this.hub.q('SELECT d.item_id, d.depends_on FROM deps d JOIN items i ON i.id = d.item_id WHERE i.project_id = ?').all(this.id)) {
        const on = this.byId.get(d.depends_on) ?? this.hub.itemById(d.depends_on); // dependencies stay in their project
        if (open(on)) (deps.get(d.item_id) ?? deps.set(d.item_id, []).get(d.item_id)).push(on);
      }
      for (const i of this.items) if (i.parent_id && open(i)) (kids.get(i.parent_id) ?? kids.set(i.parent_id, []).get(i.parent_id)).push(i);
      const out = new Map();
      for (const id of new Set([...deps.keys(), ...kids.keys()])) {
        const d = (deps.get(id) ?? []).sort((a, b) => a.seq - b.seq);
        out.set(id, [...d, ...(kids.get(id) ?? []).filter((k) => !d.some((x) => x.id === k.id))]);
      }
      return out;
    });
    return unmet.get(item.id) ?? [];
  }

  // The items each agent holds, its own or a race attempt, and the operator questions it holds (core.js
  // presenceOf): name → { items: [{ seq, stage, tidy }] by seq, questions: [{ id, held_until }] by id }.
  get holds() {
    return this.part('holds', () => {
      const out = new Map();
      const of = (name) => out.get(name) ?? out.set(name, { items: [], questions: [] }).get(name);
      const rows = this.hub.q(`SELECT holder AS agent, seq, stage, tidy FROM items WHERE project_id = ? AND holder IS NOT NULL
        UNION SELECT t.agent, i.seq, i.stage, i.tidy FROM attempts t JOIN items i ON i.id = t.item_id
          WHERE i.project_id = ? AND t.stage = 'active' AND t.closed = 0 ORDER BY seq`).all(this.id, this.id);
      for (const r of rows) of(r.agent).items.push({ seq: r.seq, stage: r.stage, tidy: r.tidy });
      for (const q of this.hub.q(`SELECT id, held_by, held_until FROM questions WHERE project_id = ? AND held_by != '' AND status = 'open' ORDER BY id`).all(this.id)) {
        of(q.held_by).questions.push({ id: q.id, held_until: q.held_until });
      }
      return out;
    });
  }

  // The track record the project page shows per agent (insight.js view), from GROUP BY queries: name → counts.
  get records() {
    return this.part('records', () => {
      const out = new Map();
      const of = (name) => out.get(name) ?? out.set(name, { landed: 0, sent_back: 0, stalls: 0, races: 0, races_won: 0 }).get(name);
      for (const r of this.hub.q(`SELECT actor,
          SUM(type = 'submitted') AS submitted, SUM(type = 'claimed') AS claimed, SUM(type = 'handoff') AS handoffs,
          SUM(type = 'question') AS questions, SUM(type = 'assumption') AS assumptions, SUM(type = 'created') AS proposed,
          SUM(type = 'accepted') AS reviews, SUM(type = 'learned') AS learned
        FROM events WHERE project_id = ? GROUP BY actor`).all(this.id)) {
        Object.assign(of(r.actor), { submitted: r.submitted, claimed: r.claimed, handoffs: r.handoffs, questions: r.questions, assumptions: r.assumptions, proposed: r.proposed, reviews: r.reviews, learned: r.learned });
      }
      for (const r of this.hub.q(`SELECT implementer, COUNT(*) AS n FROM items WHERE project_id = ? AND stage = 'done' AND implementer IS NOT NULL GROUP BY implementer`).all(this.id)) of(r.implementer).landed = r.n;
      for (const r of this.hub.q(`SELECT i.implementer, COUNT(*) AS n FROM events e JOIN items i ON i.id = e.item_id
          WHERE e.project_id = ? AND e.type = 'sent_back' AND i.implementer IS NOT NULL GROUP BY i.implementer`).all(this.id)) of(r.implementer).sent_back = r.n;
      // A lapsed lease names its agent in its data.
      for (const r of this.hub.q(`SELECT data FROM events WHERE project_id = ? AND type = 'lease_expired'`).all(this.id)) {
        const agent = json(r.data, {}).agent;
        if (typeof agent === 'string') of(agent).stalls++;
      }
      for (const r of this.hub.q(`SELECT a.agent, COUNT(*) AS entered, COALESCE(SUM(a.stage = 'chosen'), 0) AS won FROM attempts a JOIN items i ON i.id = a.item_id
          WHERE i.project_id = ? GROUP BY a.agent`).all(this.id)) Object.assign(of(r.agent), { races: r.entered, races_won: r.won });
      return out;
    });
  }
}
