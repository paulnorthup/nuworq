# Eval: the nuworq-plan skill (#96)

An agent (claude-opus-5-5, Claude Code) followed the generated `nuworq-plan/SKILL.md` against a throwaway
hub (`nuworq serve --demo --port 47961`, in memory, seeded with the demo nuworq project). No person was present:
the agent wrote the person's turns itself. Every tool call and response below is real CLI output, trimmed.

## Turn 1. Person

> I want a CSV export of finished work with what it cost, because our finance team reconciles agent spend
> every month in a spreadsheet and they copy numbers out of Flow by hand.

**Agent** (skill step 1: read the project): `checkin`, then `look`, then `look 16`.

```
board.proposed: … "#16 [soon] Cost and tokens per item" …
decisions: "Zero runtime dependencies: Node 22.13+ and its built-in SQLite only." …
#16: "Agents report tokens and cost on progress and submit; Flow shows cost per finished item by model."
```

Agent (step 2): "Who opens the file, and what has to match? Monthly ranges only, or any dates?"

## Turn 2. Person

> Finance opens it in Excel. Totals have to match Flow. Monthly is all they need, but a range would be nice.

**Agent** (step 3: options):

1. **CLI only** (`nuworq export`): fastest; finance needs someone with the CLI.
2. **Endpoint + CLI**: one HTTP endpoint that the CLI wraps; the web UI can add a download button later at no extra cost. *Recommended.*
3. **Web download button + endpoint + CLI**: most convenient for finance; the most work now.

Plain CSV in every case: xlsx would need a dependency, which the standing decision rules out.

## Turn 3. Person

> Option 2. And yes, plain CSV is fine, let's not ever do xlsx.

**Agent** (step 4: propose, with parent and depends_on; step 5: draft the decision and ask):

```
$ nuworq propose "Finance reconciles a month of agent spend from one CSV of finished items" --depends-on "#16" --acceptance "- Both child items are done.
- For a seeded month with 3 finished items, the CSV from nuworq export --month 2026-09 opens in a spreadsheet with one row per item, and its cost total matches Flow's for that month." …
{ "ok": true, "item": "#18", "stage": "ready" }

$ nuworq propose "GET /api/projects/:p/export.csv returns finished items with tokens and cost for a date range" --parent "#18" --depends-on "#16" --acceptance "- GET .../export.csv?from=2026-09-01&to=2026-09-30 answers 200 text/csv with a header row and one row per item finished in that range.
- Titles containing commas, quotes or newlines round-trip (RFC 4180 quoting), checked by a test.
- Items with no recorded cost have empty cost cells, not 0.
- A viewer token can read it; an agent token limited to another project gets 403.
- npm test passes." …
{ "ok": true, "item": "#19", "stage": "ready" }

$ nuworq propose "nuworq export --month YYYY-MM writes that month's finished-items CSV to stdout or --out file" --parent "#18" --depends-on "#19" --acceptance "- nuworq export --month 2026-09 prints the same bytes as the endpoint for 2026-09-01..2026-09-30.
- --out f.csv writes the file and prints its path; a bad --month exits non-zero with a hint showing the format.
- nuworq help lists it.
- npm test passes." …
{ "ok": true, "item": "#20", "stage": "ready" }

$ nuworq ask "#19" "Make this a standing decision: exports are plain RFC 4180 CSV, never spreadsheet-specific formats (xlsx)?" --assume "Plain CSV only, so the zero-dependency decision holds" --option "Yes: exports are plain RFC 4180 CSV, never spreadsheet-specific formats" --option "No: decide per export"
{ "ok": true, "question": 1, "blocking": false }
```

The agent wrote no decision. The draft waits for the person, who can make it a decision when they answer.

## Turn 4. Agent (step 6: read it back)

```
$ nuworq look 18
"#18" Finance reconciles a month of agent spend from one CSV of finished items
  children:   #19 [ready] GET /api/projects/:p/export.csv …   #20 [ready] nuworq export --month …
  depends_on: #16 [proposed] Cost and tokens per item
```

> #18 is the outcome (CSV matches Flow), split into #19 (the endpoint) and then #20 (the CLI), both after #16.
> The "plain CSV forever" rule is waiting for you as a question. Anything to change?

## What this shows

- 4 turns from "I want X because Y" to 3 proposals made through the tools.
- Every title states an outcome; every acceptance list is checkable by a reviewer (requests, outputs, tests).
- The order is explicit: parent #18 with children #19 and #20; #20 depends_on #19; #18 and #19 depend_on #16.
- The standing rule was drafted and asked, not written.
