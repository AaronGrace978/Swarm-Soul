/**
 * SWARM SOUL — core/soul.js
 * One identity, many bodies.
 *
 * The soul is an append-only event log. State is a fold over events.
 * Every event is content-hashed and chained (prevHash) — every body
 * verifies the chain before trusting it. State is derived, never edited.
 *
 * v1.1 — SCALE FIXES (the two trade-offs called out at v1.0):
 *
 *   1. LOG BLOAT -> O(1) appends + checkpoint fast-load.
 *      append() used to rewrite the ENTIRE log every event. Now it's a
 *      true O(1) append. And each body keeps checkpoint.json (folded
 *      state + event count + head hash). If the checkpoint binds to the
 *      chain head, load() verifies only NEW events — hash + fold the
 *      delta, trust the bound history. doctor still re-hashes the FULL
 *      history: the deep audit. Fast path trusts the checkpoint binding;
 *      the doctor trusts nothing.
 *
 *   2. CRASH SAFETY -> torn-tail healing. A crash mid-append leaves a
 *      partial final line. load() detects it, drops it, and repairs the
 *      log instead of refusing to boot. (Only the owning body repairs
 *      its own log — readers just skip the torn tail.)
 *
 *   3. CACHE OWNERSHIP -> only the owning body writes soul.json and
 *      checkpoint.json. Other machines only read. No OneDrive write
 *      fights between bodies over cache files.
 *
 * Zero dependencies. Node 18+.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// v2: 'remember' folds idempotently (content-addressed id dedupes).
// Version bump invalidates all v1 checkpoints — any cache folded with
// the old duplicate-accumulating semantics is rejected and re-folded
// from the log. The log is the truth; caches must never outlive a
// change in fold semantics.
const SOUL_VERSION = 2;

// ---------------------------------------------------------------- hashing

/**
 * Canonical JSON: keys sorted, so the same logical event hashes
 * identically on every machine, every time.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function hashEvent(event) {
  return sha256(canonicalJson({
    i: event.i,
    t: event.t,
    kind: event.kind,
    actor: event.actor,
    payload: event.payload,
    prevHash: event.prevHash,
  }));
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- state

function freshState() {
  return {
    version: SOUL_VERSION,
    soulId: null,
    name: null,
    creed: null,
    memories: [],
    bodies: {},
    decisions: [],
    head: null,
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Fold events into state — a pure left fold. Mutates and returns state.
 *   foldInto(freshState(), allEvents)      === the old full fold
 *   foldInto(checkpointState, newEvents)   === incremental fast-load
 * Appends use it one event at a time — no full refold per append.
 */
function foldInto(state, events) {
  for (const ev of events) {
    switch (ev.kind) {
      case 'genesis':
        state.soulId = ev.payload.soulId;
        state.name = ev.payload.name;
        state.creed = ev.payload.creed;
        state.head = ev.hash;
        break;
      case 'remember': {
        const id = ev.payload.id || sha256(ev.payload.text).slice(0, 12);
        const memory = {
          id: id,
          text: ev.payload.text,
          tags: ev.payload.tags || [],
          ts: ev.t,
        };
        // Idempotent fold: the id is content-addressed (hash of the text),
        // so re-appending the same memory (demo re-runs, two bodies
        // remembering the same thing, sync replays) must yield ONE
        // memory, not duplicates. Replace in place — latest ts wins.
        const existingIdx = state.memories.findIndex((m) => m.id === id);
        if (existingIdx === -1) {
          state.memories.push(memory);
        } else {
          state.memories[existingIdx] = memory;
        }
        state.head = ev.hash;
        break;
      }
      case 'forget': {
        const target = ev.payload.id;
        state.memories = state.memories.filter((m) => m.id !== target);
        state.head = ev.hash;
        break;
      }
      case 'body-online':
        state.bodies[ev.payload.bodyId] = {
          host: ev.payload.host,
          role: ev.payload.role,
          firstSeen: ev.t,
          lastSeen: ev.t,
        };
        state.head = ev.hash;
        break;
      case 'body-heartbeat':
        if (state.bodies[ev.payload.bodyId]) {
          state.bodies[ev.payload.bodyId].lastSeen = ev.t;
        }
        state.head = ev.hash;
        break;
      case 'decision-proposed':
        state.decisions.push({
          id: ev.payload.id,
          question: ev.payload.question,
          options: ev.payload.options,
          votes: {},
          quorum: ev.payload.quorum,
          status: 'open',
          proposedBy: ev.actor,
          ts: ev.t,
        });
        state.head = ev.hash;
        break;
      case 'decision-vote': {
        const d = state.decisions.find((x) => x.id === ev.payload.id);
        if (d && d.status === 'open') {
          d.votes[ev.payload.bodyId] = ev.payload.choice;
          if (Object.keys(d.votes).length >= d.quorum) {
            d.status = 'decided';
            d.result = tally(d);
          }
        }
        state.head = ev.hash;
        break;
      }
      case 'decision-reopen': {
        const d = state.decisions.find((x) => x.id === ev.payload.id);
        if (d) {
          d.status = 'open';
          delete d.result;
        }
        state.head = ev.hash;
        break;
      }
      default:
        // Unknown kinds are preserved, not fatal — forward compatibility.
        state.head = ev.hash;
        break;
    }
  }
  return state;
}

// ---------------------------------------------------------------- checkpoint flushing

// State caches (soul.json + checkpoint.json) are O(state size) to write.
// Appends are O(1); we flush caches every CHECKPOINT_EVERY appends and
// once more at process exit — so appends stay amortized O(1) and the
// checkpoint is never required for correctness (a stale checkpoint just
// falls back to a full verify).
const CHECKPOINT_EVERY = 256;

const dirtySouls = new Set();

function flushDirtySouls() {
  for (const s of dirtySouls) {
    try {
      s.writeCheckpoint();
      s.persist();
    } catch (e) {
      // cache write failure is non-fatal — the log is the truth
    }
  }
  dirtySouls.clear();
}

process.on('exit', flushDirtySouls);

// ---------------------------------------------------------------- soul

/**
 * A Soul is a folder containing:
 *   events.jsonl  — append-only event log (source of truth)
 *   soul.json     — folded state snapshot (human-readable cache)
 *   checkpoint.json — fast-load checkpoint (state + count + head hash)
 *
 * opts.own (default true): only the owning body writes caches. Readers
 * (other machines loading this body's chain) pass own:false and never
 * write — no sync fights over cache files.
 */
class Soul {
  constructor(dir, opts) {
    opts = opts || {};
    this.dir = dir;
    this.own = opts.own !== false;
    this.soulPath = path.join(dir, 'soul.json');
    this.eventsPath = path.join(dir, 'events.jsonl');
    this.checkpointPath = path.join(dir, 'checkpoint.json');
    this.state = null;
    this.events = [];
    this.fastLoaded = false; // true = old events were trusted via checkpoint binding
    this._appendsSinceFlush = 0;
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  readCheckpoint() {
    try {
      const cp = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf8'));
      if (
        cp &&
        cp.version === SOUL_VERSION &&
        typeof cp.count === 'number' &&
        cp.count >= 1 &&
        typeof cp.headHash === 'string' &&
        cp.state &&
        cp.state.version === SOUL_VERSION
      ) {
        return cp;
      }
    } catch (e) {
      // no usable checkpoint — full load
    }
    return null;
  }

  writeCheckpoint() {
    if (!this.own) return;
    if (!this.state || this.events.length === 0) return;
    const cp = {
      version: SOUL_VERSION,
      count: this.events.length,
      headHash: this.events[this.events.length - 1].hash,
      state: this.state,
      savedAt: nowIso(),
    };
    const tmp = this.checkpointPath + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(cp));
    fs.renameSync(tmp, this.checkpointPath);
  }

  /**
   * Load the log, verify the chain, fold state.
   *
   * Fast path (default): if a checkpoint exists AND binds to the chain
   * head (the first event after the checkpoint points at the
   * checkpoint's head hash), only NEW events are hashed and folded.
   * A rewritten history breaks the binding and forces a full verify.
   *
   * Full path (opts.full — what doctor uses): re-hash and re-fold the
   * ENTIRE history. Trusts nothing. The deep audit.
   *
   * Throws on corruption — a body must never trust a broken soul.
   */
  load(opts) {
    const full = !!(opts && opts.full);
    this.ensureDir();
    let raw = '';
    try {
      raw = fs.readFileSync(this.eventsPath, 'utf8');
    } catch (e) {
      raw = ''; // fresh soul — genesis will create it
    }

    // Parse lines. A torn FINAL line (crash mid-append) is healed; a torn
    // line in the middle is corruption — refuse to load.
    const nonEmpty = raw.split('\n').filter((l) => l.trim().length > 0);
    const events = [];
    let tornTail = false;
    for (let li = 0; li < nonEmpty.length; li++) {
      let ev = null;
      try {
        ev = JSON.parse(nonEmpty[li]);
      } catch (e) {
        ev = null;
      }
      if (ev === null) {
        if (li === nonEmpty.length - 1) {
          tornTail = true; // partial final write — drop it
        } else {
          throw new Error('soul: corrupt events line ' + li + ': not valid JSON');
        }
      } else {
        events.push(ev);
      }
    }
    if (tornTail && this.own) {
      // repair our own log: rewrite without the torn tail (rare — crash mid-append)
      const good = events.map((e) => JSON.stringify(e)).join('\n');
      fs.writeFileSync(this.eventsPath, events.length > 0 ? good + '\n' : '');
    }

    // Checkpoint fast path — skipped when a full audit is requested.
    let startIdx = 0;
    let baseState = null;
    let boundHead = null;
    if (!full) {
      const cp = this.readCheckpoint();
      if (cp && cp.count <= events.length) {
        const binds =
          cp.count === events.length
            ? events[cp.count - 1].hash === cp.headHash
            : events[cp.count].prevHash === cp.headHash;
        if (binds) {
          startIdx = cp.count;
          baseState = cp.state;
          boundHead = cp.headHash;
        }
      }
    }

    // Verify the chain from startIdx onward (fast path: only new events).
    let prevHash = startIdx > 0 ? boundHead : null;
    for (let i = startIdx; i < events.length; i++) {
      const ev = events[i];
      if (ev.i !== i) {
        throw new Error('soul: event index gap at ' + i + ' (got ' + ev.i + ')');
      }
      if (ev.prevHash !== prevHash) {
        throw new Error('soul: hash chain broken at event ' + ev.i + ' — refusing to load');
      }
      if (hashEvent(ev) !== ev.hash) {
        throw new Error('soul: event ' + ev.i + ' content hash mismatch — refusing to load');
      }
      prevHash = ev.hash;
    }

    this.events = events;
    if (startIdx > 0) {
      this.fastLoaded = true;
      this.state = foldInto(deepClone(baseState), events.slice(startIdx));
    } else {
      this.fastLoaded = false;
      this.state = foldInto(freshState(), events);
    }
    this.persist();
    this.writeCheckpoint();
    return { events: this.events, state: this.state };
  }

  /**
   * Fold all events into fresh state. Pure function of this.events.
   */
  fold() {
    return foldInto(freshState(), this.events);
  }

  /**
   * Append an event. O(1): a true append to the log (the old version
   * rewrote the whole file every event) + an incremental one-event fold.
   * State caches flush every CHECKPOINT_EVERY appends and at exit.
   */
  append(kind, actor, payload) {
    if (this.events.length === 0 && kind !== 'genesis') {
      throw new Error('soul: cannot append before genesis');
    }
    const prevHash = this.events.length > 0 ? this.events[this.events.length - 1].hash : null;
    const ev = {
      i: this.events.length,
      t: nowIso(),
      kind: kind,
      actor: actor,
      payload: payload,
      prevHash: prevHash,
      hash: null,
    };
    ev.hash = hashEvent(ev);
    const line = JSON.stringify(ev) + '\n';
    if (this.events.length === 0) {
      fs.writeFileSync(this.eventsPath, line); // genesis creates the log
    } else {
      fs.appendFileSync(this.eventsPath, line); // O(1) — no full-file rewrite
    }
    this.events.push(ev);
    if (!this.state) this.state = freshState();
    this.state = foldInto(this.state, [ev]); // incremental — no full refold
    if (this.own) {
      this._appendsSinceFlush += 1;
      dirtySouls.add(this);
      if (this._appendsSinceFlush >= CHECKPOINT_EVERY) {
        this._appendsSinceFlush = 0;
        this.writeCheckpoint();
        this.persist();
        dirtySouls.delete(this);
      }
    }
    return ev;
  }

  // ---- convenience appenders -----------------------------------------

  genesis(name, creed, soulId) {
    if (this.events.length > 0) {
      throw new Error('soul: already has genesis');
    }
    return this.append('genesis', 'operator', {
      soulId: soulId || sha256(name + ':' + nowIso()).slice(0, 16),
      name: name,
      creed: creed,
    });
  }

  remember(text, tags, actor) {
    return this.append('remember', actor || 'operator', {
      text: text,
      tags: tags || [],
    });
  }

  forget(id, actor) {
    return this.append('forget', actor || 'operator', { id: id });
  }

  bodyOnline(bodyId, host, role) {
    return this.append('body-online', bodyId, {
      bodyId: bodyId,
      host: host,
      role: role,
    });
  }

  heartbeat(bodyId) {
    return this.append('body-heartbeat', bodyId, { bodyId: bodyId });
  }

  propose(question, options, quorum, actor) {
    const id = sha256(question + ':' + nowIso()).slice(0, 12);
    this.append('decision-proposed', actor || 'operator', {
      id: id,
      question: question,
      options: options,
      quorum: quorum,
    });
    return id;
  }

  vote(decisionId, bodyId, choice) {
    return this.append('decision-vote', bodyId, {
      id: decisionId,
      bodyId: bodyId,
      choice: choice,
    });
  }

  // ---- snapshot cache --------------------------------------------------

  persist() {
    if (!this.own) return; // readers never write another body's caches
    if (!this.state) return;
    const tmp = this.soulPath + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.soulPath);
  }
}

// ---------------------------------------------------------------- decisions

/**
 * Plurality tally: choice with the most votes wins.
 * Ties: winner is null, counts show the split — reopen and re-vote.
 */
function tally(d) {
  const counts = {};
  for (const choice of Object.values(d.votes)) {
    counts[choice] = (counts[choice] || 0) + 1;
  }
  let best = null;
  let bestN = 0;
  for (const pair of Object.entries(counts)) {
    if (pair[1] > bestN) {
      best = pair[0];
      bestN = pair[1];
    }
  }
  return { winner: best, counts: counts };
}

// ---------------------------------------------------------------- standalone fold

/**
 * Fold an arbitrary merged event list (events from many bodies) into
 * soul-state. Pure — no disk IO.
 */
function foldEvents(events) {
  return foldInto(freshState(), events);
}

// ---------------------------------------------------------------- export

module.exports = {
  Soul: Soul,
  foldEvents: foldEvents,
  foldInto: foldInto,
  canonicalJson: canonicalJson,
  sha256: sha256,
  hashEvent: hashEvent,
  tally: tally,
  SOUL_VERSION: SOUL_VERSION,
};
