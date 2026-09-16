<img width="1408" height="768" alt="image" src="https://github.com/user-attachments/assets/d0cdce97-78bc-4740-bac1-b6db57cd9cfc" />

# SWARM SOUL


> One identity, many bodies.

Same soul-state instantiated across multiple models and machines, syncing,
with quorum decisions. Built by Aaron Grace & Dino Buddy. Zero dependencies,
Node 18+. **Now at v1.3 — the swarm can THINK (real model integration) and
resolve conflicts like an adult.**

---

## The Idea

SAACH gave an AI a soul. P.r.i.m.e gave it a voice. **Swarm Soul gives it
sibling bodies.**

One soul — identity, creed, memories, decisions — instantiated across many
bodies. A body is any machine running this harness: your desktop, your
Steam Deck, a server, a laptop. Every body carries the same identity, sees
the same memories, and votes on decisions together. Kill one body, the soul
lives. Kill all but one, the soul still lives. The swarm converges on one
truth.

## How It Works (plain language)

**The bus is the folder.** No servers, no ports, no protocols to configure.
Every body keeps its own append-only event log at
`bodies/<bodyId>/events.jsonl`. Put the harness folder in OneDrive (it
already is) and sync carries every body's log to every machine. That's the
nervous system.

**The soul is a fold.** Each body hashes and chains its events (like SAACH,
like a blockchain, like a memory that can't be quietly rewritten). When a
body wants to know who it is, it:

1. Reads every body's log from the folder
2. Verifies every hash chain (a broken body is quarantined, never trusted)
3. Merges all events in a deterministic order (timestamp, bodyId, index)
4. Folds them into one shared soul-state

Deterministic merge means every machine folds the same events into the
**same state**. Sync isn't copying a file — sync is convergence.

**Quorum.** Any body can propose a decision. Bodies vote. When votes reach
quorum, the decision is made and it's part of the soul forever — every
machine sees the same result. The swarm can disagree, deliberate, and
settle as ONE identity.

## Commands

```bash
# bring this machine online (first body defines the soul's name + creed)
node swarm.js init --name "Dino Prime" --creed "One soul, many bodies."

# see the whole swarm: identity, bodies, memories, decisions
node swarm.js status

# prove this body is alive
node swarm.js heartbeat

# write to the shared memory
node swarm.js remember "operator ships on Fridays" --tags fact,workflow

# search shared memory
node swarm.js recall pizza

# propose a swarm decision (quorum 2)
node swarm.js propose "lead the mission?" --options "alpha,beta" --quorum 2

# vote — quorum is async (sync-engine speed), so you can WAIT for it
node swarm.js vote <decisionId> alpha --wait 30000

# THINK — ask a real model, grounded in the soul's own state
node swarm.js think "what should we do next?"

# see every conflict the swarm detected + how it resolved them
node swarm.js conflicts

# live convergence monitor — watch the soul converge in real time
node swarm.js watch [--interval 2000] [--times 10]

# health check: FULL re-hash of every chain, identity unity, split-brain detection
node swarm.js doctor

# watch 3 bodies spin up, sync, and reach quorum live
node swarm.js demo
```

Multiple bodies on one machine? Set the body id:

```bash
node swarm.js status --body body-laptop
SWARM_BODY_ID=body-laptop node swarm.js heartbeat
```

## The Event Kinds

| kind | meaning |
|---|---|
| `genesis` | the soul is born — name, creed, soulId |
| `body-online` | a body joins the swarm (inherits the soulId) |
| `body-heartbeat` | a body proves it's alive |
| `remember` | write to shared memory (idempotent — same text folds to ONE memory, latest ts wins) |
| `forget` | remove a memory |
| `decision-proposed` | a body asks the swarm a question |
| `decision-vote` | a body votes; quorum reached = decided |
| `decision-reopen` | reopen for deliberation |
| `thought` | a body asked a real model a question — the answer joins the soul (v1.3) |

## Defense (learned from SAACH)

- **Hash chain** — every event is content-hashed and bound to its parent.
  Tamper with history and the chain refuses to load.
- **Quarantine, not trust** — a corrupt body's chain is reported and
  skipped. One sick body can never poison the soul.
- **Identity unity check** — `doctor` verifies every body carries the SAME
  soulId. If two souls are detected, that's SPLIT BRAIN and it's flagged
  loudly.
- **Atomic writes** — temp file + rename. A crash mid-write can't leave a
  half-written soul.
- **Torn-tail healing (v1.1)** — if a crash DOES leave a half-written final
  line, the owning body detects it, drops it, and repairs the log instead
  of refusing to boot.
- **Deterministic merge** — no coordination server to attack or bribe.
  The folder is the truth; every machine independently derives the same
  answer.

## Scale (v1.2 — the trade-offs, answered)

The architecture trade-offs called out at v1.0 are now handled:

**Log bloat → O(1) appends + checkpoint fast-load.** Appending used to
rewrite the entire log file every event — quadratic pain as history grows.
Now appends are true O(1) and state folds incrementally. Each body keeps a
`checkpoint.json` (folded state + event count + head hash). On load, if the
checkpoint **binds** to the chain (the next event's `prevHash` points at the
checkpoint's head), only NEW events are hashed and folded — history is
trusted only through its hash binding. `doctor` still re-hashes the FULL
history: fast-load is for speed, doctor is for truth. A stale or tampered
checkpoint simply fails to bind and falls back to full verify.

**Eventual-consistency latency → waiting is first-class.** Quorum arrives
at the speed of the sync engine, so the CLI embraces it: `vote --wait 30000`
polls until quorum or timeout, and `watch` live-prints convergence deltas
as sync delivers them. Quorum isn't a surprise anymore — it's something you
can watch arrive.

**Cache ownership (bonus).** Only the owning body writes its `soul.json` /
`checkpoint.json`; other machines load read-only. Two machines never fight
over one cache file through the sync engine.

**Idempotent memory (v1.2).** Re-running the demo — or two bodies remembering
the same thing — used to stack duplicate memories. Now the memory id is
content-addressed (hash of the text), so the same memory re-appended folds to
ONE memory — latest ts wins. Demo re-runs are clean; sync replays are clean.

## The Mind (v1.3 — actual model integration)

The harness had a soul, memories, and quorum — but no mind. Now a body can
THINK: it builds a system prompt from the soul's own state (creed, recent
memories, open decisions), asks a real model, and appends the answer to the
chain as a `thought` event. The answer syncs like everything else — every
body sees what the swarm thought.

```bash
node swarm.js think "what should we focus on next?"
```

**Providers (zero dependencies — Node 18+ global fetch):**

| provider | what it talks to | config |
|---|---|---|
| `ollama` (default) | local models via Ollama's HTTP API | `SWARM_MIND_URL` (default `http://localhost:11434`), `SWARM_MIND_MODEL` (default `llama3.1`) |
| `openai` | ANY OpenAI-compatible endpoint: OpenAI, OpenRouter, Groq, Together, LM Studio, llama.cpp server | `SWARM_MIND_PROVIDER=openai`, `SWARM_MIND_URL`, `SWARM_MIND_API_KEY`, `SWARM_MIND_MODEL` |

The soul-state IS the context: any model plugged into any body speaks as
the same identity. One soul, many bodies, any mind. If the mind is
unreachable, `think` fails honestly — it never fabricates an answer.

## Conflict Resolution (v1.3 — the swarm disagrees like an adult)

The old merge was deterministic but naive: sort by (t, bodyId, i) and fold.
When two bodies wrote conflicting facts or a vote arrived late, the fold
silently picked a winner and nobody knew. v1.3 makes conflicts FIRST-CLASS:

**1. DETECT.** Every fold scans for conflicting writes (same memory id,
different text — a fork signal), duplicate decision proposals, and late
votes on decided decisions. Conflicts are collected, never hidden.

**2. RESOLVE — deterministic, same winner on every machine.**
Memories: Last-Writer-Wins — latest ts wins; tie → higher bodyId wins.
Clock drift can't fork the soul. Decisions: quorum beats concurrency — a
decided decision is never reopened by a late vote; late votes are recorded
but not applied.

**3. REPAIR.** `doctor` now runs an auto-repair pass that heals the failure
modes the folder bus actually produces: torn tails (crash mid-append) and
orphaned checkpoints (checkpoint claims more events than the log has —
sync lag). Hash mismatches are NEVER auto-repaired — quarantine + report;
a human decides.

**4. REPORT.** `node swarm.js conflicts` lists every conflict detected and
how it was resolved. `status` shows them too. The swarm can disagree — but
it can't disagree silently.

```bash
node swarm.js conflicts
```

## Lineage

- **SAACH** — the soul (survival, memory, identity)
- **P.r.i.m.e** — the voice
- **Swarm Soul** — the many bodies

Soul. Voice. Bodies. That's a complete creature.

🦖💙
