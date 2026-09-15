/**
 * SWARM SOUL — core/swarm.js
 * The swarm: many bodies, one soul.
 *
 * THE BUS IS THE FOLDER. Every body keeps its own hash-chained event log
 * at bodies/<bodyId>/events.jsonl. OneDrive (or any folder sync) is
 * the nervous system carrying every body's log to every other machine.
 * A body loads the soul by reading + verifying ALL chains, merging events
 * deterministically, and folding them into one shared identity.
 *
 * Determinism: merged events sort by (timestamp, bodyId, index), so every
 * machine folds the same event set into the same state. Sync = converge.
 *
 * v1.1 — SCALE + LATENCY FIXES:
 *   - Cache ownership: only the OWNING body writes soul.json/
 *     checkpoint.json for its folder. Other machines load read-only —
 *     no sync-engine write fights over cache files.
 *   - doctor does a FULL deep audit (re-hashes every event of every
 *     chain). status/fold use the checkpoint fast path.
 *   - waitDecision(): poll until a decision reaches quorum — quorum is
 *     asynchronous by nature (sync-engine speed), so waiting is a
 *     first-class operation, not a surprise.
 *   - watch(): live convergence monitor — re-fold on an interval and
 *     print deltas as sync delivers them.
 *
 * Zero dependencies. Node 18+.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Soul, foldEvents } = require('./soul');

const STALE_AFTER_MS = 5 * 60 * 1000; // silent for 5 min = stale

/** Zero-dep sleep (Atomics.wait works on Node's main thread). */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A body's identity is machine-local: hostname by default,
 * SWARM_BODY_ID env or --body flag to override (great for testing
 * several bodies on one machine).
 */
function defaultBodyId(override) {
  if (override) return String(override);
  if (process.env.SWARM_BODY_ID) return String(process.env.SWARM_BODY_ID);
  const host = (os.hostname() || 'unknown').toLowerCase();
  return 'body-' + host.replace(/[^a-z0-9-]+/g, '-');
}

class Swarm {
  constructor(root, bodyIdOverride) {
    this.root = root;
    this.bodiesDir = path.join(root, 'bodies');
    this.bodyId = defaultBodyId(bodyIdOverride);
  }

  // ---- this body's chain ---------------------------------------------

  myDir() {
    return path.join(this.bodiesDir, this.bodyId);
  }

  mySoul() {
    return new Soul(this.myDir(), { own: true }); // we own our caches
  }

  // ---- the swarm view --------------------------------------------------

  /**
   * Load and verify EVERY body's chain.
   *   opts.full — deep audit: re-hash the ENTIRE history of every chain
   *               (doctor uses this; trusts no checkpoint).
   *   default   — checkpoint fast path: hash only events newer than the
   *               last bound checkpoint.
   * Cache ownership: this machine's own chain loads own:true (may write
   * caches); every other body's chain loads own:false (read-only — the
   * other machine owns those cache files, and OneDrive would otherwise
   * see two writers fighting over one file).
   * Corrupt chains are reported, not trusted — one broken body can
   * never poison the soul.
   */
  chains(opts) {
    let ids = [];
    try {
      ids = fs
        .readdirSync(this.bodiesDir)
        .filter((name) => fs.statSync(path.join(this.bodiesDir, name)).isDirectory());
    } catch (e) {
      ids = []; // no bodies yet — fresh swarm
    }
    const chains = [];
    const errors = [];
    for (const id of ids) {
      const isOwn = id === this.bodyId;
      const s = new Soul(path.join(this.bodiesDir, id), { own: isOwn });
      try {
        s.load({ full: !!(opts && opts.full) });
        chains.push({ bodyId: id, soul: s, events: s.events, fastLoaded: s.fastLoaded });
      } catch (e) {
        errors.push({ bodyId: id, error: e.message });
      }
    }
    chains.sort((a, b) => (a.bodyId < b.bodyId ? -1 : 1));
    return { chains: chains, errors: errors };
  }

  /**
   * Deterministic merge: sort by (t, bodyId, i). Same event set on any
   * machine folds to the same soul-state. That's what makes us ONE
   * identity instead of many opinions.
   */
  mergeEvents(chains) {
    const all = [];
    for (const c of chains) {
      for (const ev of c.events) {
        all.push({ ev: ev, bodyId: c.bodyId });
      }
    }
    all.sort((a, b) => {
      if (a.ev.t !== b.ev.t) return a.ev.t < b.ev.t ? -1 : 1;
      if (a.bodyId !== b.bodyId) return a.bodyId < b.bodyId ? -1 : 1;
      return a.ev.i - b.ev.i;
    });
    return all.map((x) => x.ev);
  }

  fold(opts) {
    const { chains, errors } = this.chains(opts);
    const merged = this.mergeEvents(chains);
    const state = foldEvents(merged);
    return { state: state, chains: chains, errors: errors };
  }

  status() {
    const { state, chains, errors } = this.fold();
    const now = Date.now();
    const bodies = chains.map((c) => {
      const last = c.events.length > 0 ? c.events[c.events.length - 1] : null;
      const lastTs = last ? last.t : null;
      const ageMs = lastTs ? now - Date.parse(lastTs) : null;
      const reg = state.bodies[c.bodyId] || {};
      return {
        bodyId: c.bodyId,
        role: reg.role || null,
        host: reg.host || null,
        events: c.events.length,
        head: last ? last.hash : null,
        lastEventTs: lastTs,
        lastEventAgeSec: ageMs === null ? null : Math.round(ageMs / 1000),
        stale: ageMs === null ? true : ageMs > STALE_AFTER_MS,
      };
    });
    return { state: state, bodies: bodies, errors: errors };
  }

  // ---- actions (write to THIS body's chain) ---------------------------

  requireInit() {
    const s = this.mySoul();
    s.load();
    if (s.events.length === 0) {
      throw new Error('no soul on this body yet — run: node swarm.js init');
    }
    return s;
  }

  /**
   * Bring this body online. If a soul already exists in the swarm, this
   * body's genesis REUSES its soulId — one identity, many bodies. The
   * first body defines the soul; every body after that inherits it.
   */
  init(name, creed, role) {
    const existing = this.fold().state;
    const soulId = existing.soulId || null;
    const useName = existing.name || name;
    const useCreed = existing.creed || creed;
    if (!useName || !useCreed) {
      throw new Error('init needs --name and --creed (the first body defines the soul)');
    }
    const s = this.mySoul();
    s.load();
    if (s.events.length > 0) {
      return {
        already: true,
        bodyId: this.bodyId,
        soulId: existing.soulId || s.state.soulId,
      };
    }
    s.genesis(useName, useCreed, soulId);
    s.bodyOnline(this.bodyId, os.hostname() || 'unknown', role || 'worker');
    return { already: false, bodyId: this.bodyId, soulId: s.state.soulId };
  }

  heartbeat() {
    const s = this.requireInit();
    return s.heartbeat(this.bodyId);
  }

  remember(text, tags) {
    const s = this.requireInit();
    return s.remember(text, tags || [], this.bodyId);
  }

  recall(query) {
    const { state } = this.fold();
    const q = String(query).toLowerCase();
    return state.memories.filter((m) => {
      if (m.text.toLowerCase().includes(q)) return true;
      return (m.tags || []).some((t) => String(t).toLowerCase().includes(q));
    });
  }

  propose(question, options, quorum) {
    const s = this.requireInit();
    return s.propose(question, options, quorum, this.bodyId);
  }

  vote(decisionId, choice) {
    const s = this.requireInit();
    return s.vote(decisionId, this.bodyId, choice);
  }

  // ---- async quorum (the eventual-consistency answer) ------------------

  /**
   * Quorum is asynchronous by nature — it arrives at the speed of the
   * sync engine. So waiting is a first-class operation. Poll the folder
   * bus until the decision is decided, or timeout. Returns the decision
   * (whatever its status) so the caller can report honestly.
   */
  waitDecision(decisionId, timeoutMs, pollMs, onPoll) {
    const deadline = Date.now() + (timeoutMs || 30000);
    const poll = pollMs || 1000;
    let d = null;
    for (;;) {
      const { state } = this.fold();
      d = state.decisions.find((x) => x.id === decisionId) || null;
      if (d && d.status === 'decided') return d;
      if (Date.now() >= deadline) return d;
      if (onPoll) onPoll(d);
      sleep(poll);
    }
  }

  /**
   * Live convergence monitor. Re-fold the swarm on an interval and print
   * a delta line whenever sync delivers something new. This is what
   * eventual consistency FEELS like — you watch the soul converge.
   * Returns a stop() handle (used by CLI --times N; default runs forever).
   */
  watch(intervalMs, maxPolls) {
    const interval = intervalMs || 2000;
    let lastHead = null;
    let polls = 0;
    const self = this;
    const tick = () => {
      polls += 1;
      const { state, chains, errors } = self.fold();
      const totalEvents = chains.reduce((n, c) => n + c.events.length, 0);
      const changed = state.head !== lastHead;
      if (changed) {
        const ts = new Date().toISOString().slice(11, 19);
        const decided = state.decisions.filter((x) => x.status === 'decided').length;
        const open = state.decisions.filter((x) => x.status === 'open');
        const openList = open
          .map((x) => x.id.slice(0, 8) + ' ' + Object.keys(x.votes).length + '/' + x.quorum)
          .join(', ');
        console.log(
          '[' + ts + '] head=' + (state.head || '').slice(0, 12) +
          ' events=' + totalEvents +
          ' bodies=' + chains.length +
          ' memories=' + state.memories.length +
          ' decisions: ' + decided + ' decided' +
          (open.length > 0 ? ', OPEN [' + openList + ']' : '')
        );
        if (errors.length > 0) {
          console.log('           chain errors (quarantined): ' + errors.map((e) => e.bodyId).join(', '));
        }
        lastHead = state.head;
      }
      if (maxPolls && polls >= maxPolls) return false;
      sleep(interval);
      return true;
    };
    while (tick()) {
      // tick() does the sleeping — loop until it says stop
    }
    return { stopped: true, polls: polls };
  }

  // ---- deep audit ------------------------------------------------------

  /**
   * Full verify of everything: re-hash every event of every chain,
   * cross-check identity unity. The doctor trusts NO checkpoint —
   * fast-load is for speed; this is for truth.
   */
  audit() {
    const { chains, errors } = this.chains({ full: true });
    const soulIds = new Set();
    for (const c of chains) {
      if (c.events.length > 0) soulIds.add(c.events[0].payload.soulId);
    }
    return {
      chains: chains,
      errors: errors,
      soulIds: soulIds,
      splitBrain: soulIds.size > 1,
    };
  }
}

module.exports = {
  Swarm: Swarm,
  sleep: sleep,
  STALE_AFTER_MS: STALE_AFTER_MS,
};
