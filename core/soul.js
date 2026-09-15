/**
 * SWARM SOUL — core/soul.js
 * One identity, many bodies.
 *
 * The soul is an append-only event log. State is a fold over events.
 * Every event is content-hashed and chained (prevHash) — every body
 * verifies the chain before trusting it. State is derived, never edited.
 *
 * Zero dependencies. Node 18+.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SOUL_VERSION = 1;

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

// ---------------------------------------------------------------- soul

/**
 * A Soul is a folder containing:
 *   events.jsonl — append-only event log (source of truth)
 *   soul.json    — folded state snapshot (cache, rebuilt from the log)
 */
class Soul {
  constructor(dir) {
    this.dir = dir;
    this.soulPath = path.join(dir, 'soul.json');
    this.eventsPath = path.join(dir, 'events.jsonl');
    this.state = null;
    this.events = [];
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Load the log, verify the full hash chain, fold state.
   * Throws on corruption — a body must never trust a broken soul.
   */
  load() {
    this.ensureDir();
    let raw = '';
    try {
      raw = fs.readFileSync(this.eventsPath, 'utf8');
    } catch (e) {
      raw = ''; // fresh soul — genesis will create it
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const events = [];
    let expectedIndex = 0;
    let prevHash = null;
    for (const line of lines) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (e) {
        throw new Error('soul: corrupt events line ' + expectedIndex + ': not valid JSON');
      }
      if (ev.i !== expectedIndex) {
        throw new Error('soul: event index gap at ' + expectedIndex + ' (got ' + ev.i + ')');
      }
      if (ev.prevHash !== prevHash) {
        throw new Error('soul: hash chain broken at event ' + ev.i + ' — refusing to load');
      }
      if (hashEvent(ev) !== ev.hash) {
        throw new Error('soul: event ' + ev.i + ' content hash mismatch — refusing to load');
      }
      events.push(ev);
      prevHash = ev.hash;
      expectedIndex += 1;
    }
    this.events = events;
    this.state = this.fold();
    this.persist();
    return { events: this.events, state: this.state };
  }

  /**
   * Fold events into state. Pure function of the log.
   * State: { version, soulId, name, creed, memories[], bodies{}, decisions[], head }
   */
  fold() {
    const state = {
      version: SOUL_VERSION,
      soulId: null,
      name: null,
      creed: null,
      memories: [],
      bodies: {},
      decisions: [],
      head: null,
    };
    for (const ev of this.events) {
      switch (ev.kind) {
        case 'genesis':
          state.soulId = ev.payload.soulId;
          state.name = ev.payload.name;
          state.creed = ev.payload.creed;
          state.head = ev.hash;
          break;
        case 'remember': {
          const id = ev.payload.id || sha256(ev.payload.text).slice(0, 12);
          state.memories.push({
            id: id,
            text: ev.payload.text,
            tags: ev.payload.tags || [],
            ts: ev.t,
          });
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

  /**
   * Append an event. Atomic-ish: write temp file, then rename over the log.
   */
  append(kind, actor, payload) {
    if (this.events.length === 0 && kind !== 'genesis') {
      throw new Error('soul: cannot append before genesis');
    }
    const prevHash = this.events.length > 0
      ? this.events[this.events.length - 1].hash
      : null;
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
    const tmp = this.eventsPath + '.tmp-' + process.pid;
    const existing = fs.existsSync(this.eventsPath)
      ? fs.readFileSync(this.eventsPath, 'utf8')
      : '';
    fs.writeFileSync(tmp, existing + line);
    fs.renameSync(tmp, this.eventsPath);
    this.events.push(ev);
    this.state = this.fold();
    this.persist();
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
 * soul-state. fold() is a pure function of this.events — no disk IO —
 * so we reuse it through a throwaway Soul instance.
 */
function foldEvents(events) {
  const s = new Soul('.');
  s.events = events;
  return s.fold();
}

// ---------------------------------------------------------------- export

module.exports = {
  Soul: Soul,
  foldEvents: foldEvents,
  canonicalJson: canonicalJson,
  sha256: sha256,
  hashEvent: hashEvent,
  tally: tally,
  SOUL_VERSION: SOUL_VERSION,
};
