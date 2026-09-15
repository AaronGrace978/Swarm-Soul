/**
 * SWARM SOUL — core/swarm.js
 * The swarm: many bodies, one soul.
 *
 * THE BUS IS THE FOLDER. Every body keeps its own hash-chained event log
 * at data/bodies/<bodyId>/events.jsonl. OneDrive (or any folder sync) is
 * the nervous system carrying every body's log to every other machine.
 * A body loads the soul by reading + verifying ALL chains, merging events
 * deterministically, and folding them into one shared identity.
 *
 * Determinism: merged events sort by (timestamp, bodyId, index), so every
 * machine folds the same event set into the same state. Sync = converge.
 *
 * Zero dependencies. Node 18+.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Soul, foldEvents } = require('./soul');

const STALE_AFTER_MS = 5 * 60 * 1000; // silent for 5 min = stale

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
    return new Soul(this.myDir());
  }

  // ---- the swarm view --------------------------------------------------

  /**
   * Load and verify EVERY body's chain. Corrupt chains are reported,
   * not trusted — one broken body can never poison the soul.
   */
  chains() {
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
      const s = new Soul(path.join(this.bodiesDir, id));
      try {
        s.load();
        chains.push({ bodyId: id, soul: s, events: s.events });
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

  fold() {
    const { chains, errors } = this.chains();
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
}

module.exports = {
  Swarm: Swarm,
  defaultBodyId: defaultBodyId,
  STALE_AFTER_MS: STALE_AFTER_MS,
};
