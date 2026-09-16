/**
 * SWARM SOUL — core/conflicts.js
 * Conflict resolution: when bodies disagree, the soul still converges.
 *
 * v1.3 — ROBUST CONFLICT RESOLUTION. The old merge was deterministic but
 * naive: sort by (t, bodyId, i) and fold. When two bodies wrote
 * conflicting facts or a vote arrived late, the fold silently picked a
 * winner and nobody knew. v1.3 makes conflicts FIRST-CLASS:
 *
 *   1. DETECT  — every fold can scan for conflicting writes (same key,
 *      different content), duplicate proposals, and late votes.
 *      Conflicts are collected, never hidden.
 *   2. RESOLVE — deterministic policy, same winner on every machine:
 *      latest ts wins; tie -> higher bodyId wins. Clock drift can't
 *      fork the soul.
 *   3. REPAIR  — autoRepair() heals the failure modes the folder bus
 *      actually produces: torn tails and orphaned checkpoints.
 *      Hash mismatches are NEVER auto-repaired — quarantine + report;
 *      a human decides.
 *   4. REPORT  — conflicts surface in status/doctor output.
 *
 * Zero dependencies. Node 18+.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- detection

/**
 * Scan a merged event list for conflicts. Pure — no IO.
 * Returns { conflicts } — an array of:
 *   { kind: 'memory' | 'decision', key, bodies: [..], detail, ts }
 */
function detectConflicts(events) {
  const conflicts = [];
  const memById = new Map(); // id -> { bodies:Set, texts:Set, ts }
  const decisionsById = new Map(); // id -> { bodies:Set, status, votes:Map }

  for (const ev of events) {
    if (ev.kind === 'remember') {
      const id = ev.payload.id || 'auto:' + ev.actor + ':' + ev.i;
      let rec = memById.get(id);
      if (!rec) {
        rec = { bodies: new Set(), texts: new Set(), ts: ev.t };
        memById.set(id, rec);
      }
      rec.bodies.add(ev.actor);
      rec.texts.add(ev.payload.text);
    } else if (ev.kind === 'decision-proposed') {
      const id = ev.payload.id;
      let rec = decisionsById.get(id);
      if (!rec) {
        rec = {
          bodies: new Set(),
          status: 'open',
          votes: new Map(),
          quorum: ev.payload.quorum || Infinity,
        };
        decisionsById.set(id, rec);
      }
      rec.bodies.add(ev.actor);
      if (rec.bodies.size > 1) {
        conflicts.push({
          kind: 'decision',
          key: id,
          bodies: Array.from(rec.bodies),
          detail: 'two bodies proposed the same decision id — possible soul fork',
          ts: ev.t,
        });
      }
    } else if (ev.kind === 'decision-vote') {
      const rec = decisionsById.get(ev.payload.id);
      if (rec) {
        if (rec.status === 'decided') {
          conflicts.push({
            kind: 'decision',
            key: ev.payload.id,
            bodies: [ev.payload.bodyId],
            detail: 'late vote after decision was decided — recorded, not applied',
            ts: ev.t,
          });
        } else {
          rec.votes.set(ev.payload.bodyId, ev.payload.choice);
          // mirror the fold's quorum rule so late votes are caught
          if (rec.votes.size >= rec.quorum) rec.status = 'decided';
        }
      }
    } else if (ev.kind === 'decision-reopen') {
      const rec = decisionsById.get(ev.payload.id);
      if (rec) rec.status = 'open';
    }
  }

  for (const [id, rec] of memById) {
    if (rec.texts.size > 1) {
      conflicts.push({
        kind: 'memory',
        key: id,
        bodies: Array.from(rec.bodies),
        detail: 'same memory id, different text — fork signal',
        ts: rec.ts,
      });
    }
  }
  return { conflicts: conflicts };
}

// ---------------------------------------------------------------- resolution

/**
 * Last-Writer-Wins with deterministic tie-break: latest ts wins; tie ->
 * higher bodyId wins. Same winner on every machine, always.
 */
function lww(a, b) {
  if (a.ts !== b.ts) return a.ts > b.ts ? a : b;
  return (a.bodyId || '') > (b.bodyId || '') ? a : b;
}

/**
 * Resolve memory conflicts: for each conflicted id, pick the LWW winner
 * deterministically. Returns resolution records for reporting (the fold
 * itself already applies LWW via replace-in-place — this makes the
 * CHOICE explicit and auditable).
 */
function resolveMemoryConflicts(conflicts, state) {
  const resolutions = [];
  for (const c of conflicts) {
    if (c.kind !== 'memory') continue;
    const candidates = (state.memories || []).filter((m) => m.id === c.key);
    if (candidates.length === 0) continue; // already forgotten
    const winner = candidates.reduce(lww);
    resolutions.push({
      key: c.key,
      winnerId: winner.id,
      winnerTs: winner.ts,
      policy: 'LWW (latest ts; tie -> higher bodyId)',
    });
  }
  return resolutions;
}

// ---------------------------------------------------------------- repair

function readCheckpointForRepair(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Auto-repair the failure modes the folder bus actually produces:
 *   torn tails          — crash mid-append leaves a partial final line -> healed
 *   orphaned checkpoints — checkpoint claims more events than the log has
 *                          (sync lag) -> dropped, full verify takes over
 *   hash mismatches     — tampering or bit rot: NOT auto-repaired.
 *                          Quarantined + reported. A human decides.
 * Returns { repaired: [...], quarantined: [...] }.
 */
function autoRepair(bodiesDir) {
  const repaired = [];
  const quarantined = [];
  let ids = [];
  try {
    ids = fs
      .readdirSync(bodiesDir)
      .filter((name) => fs.statSync(path.join(bodiesDir, name)).isDirectory());
  } catch (e) {
    return { repaired: repaired, quarantined: quarantined }; // no bodies yet
  }
  for (const id of ids) {
    const dir = path.join(bodiesDir, id);
    const eventsPath = path.join(dir, 'events.jsonl');
    const checkpointPath = path.join(dir, 'checkpoint.json');
    let raw = '';
    try {
      raw = fs.readFileSync(eventsPath, 'utf8');
    } catch (e) {
      continue; // no log — nothing to repair
    }
    const nonEmpty = raw.split('\n').filter((l) => l.trim().length > 0);
    const events = [];
    let tornTail = false;
    let midLogCorrupt = false;
    for (let li = 0; li < nonEmpty.length; li++) {
      let ev = null;
      try {
        ev = JSON.parse(nonEmpty[li]);
      } catch (e) {
        ev = null;
      }
      if (ev === null) {
        if (li === nonEmpty.length - 1) {
          tornTail = true;
        } else {
          midLogCorrupt = true;
        }
      } else {
        events.push(ev);
      }
    }
    if (midLogCorrupt) {
      quarantined.push({ bodyId: id, reason: 'corrupt line mid-log — NOT auto-repaired, human review needed' });
      continue;
    }
    if (tornTail) {
      const good = events.map((e) => JSON.stringify(e)).join('\n');
      fs.writeFileSync(eventsPath, events.length > 0 ? good + '\n' : '');
      repaired.push({ bodyId: id, reason: 'torn tail healed' });
    }
    const cp = readCheckpointForRepair(checkpointPath);
    if (cp && typeof cp.count === 'number' && cp.count > events.length) {
      try {
        fs.unlinkSync(checkpointPath);
      } catch (e) {
        // best effort
      }
      quarantined.push({ bodyId: id, reason: 'orphaned checkpoint (count ' + cp.count + ' > log ' + events.length + ') — dropped, full verify takes over' });
    }
  }
  return { repaired: repaired, quarantined: quarantined };
}

// ---------------------------------------------------------------- export

module.exports = {
  detectConflicts: detectConflicts,
  resolveMemoryConflicts: resolveMemoryConflicts,
  autoRepair: autoRepair,
  lww: lww,
};
