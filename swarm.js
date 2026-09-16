/**
 * SWARM SOUL — swarm.js (CLI entrypoint)
 * One identity, many bodies.
 *
 * Usage:
 *   node swarm.js init --name <name> --creed <creed> [--role <role>] [--body <id>]
 *   node swarm.js status
 *   node swarm.js heartbeat
 *   node swarm.js remember "text" [--tags a,b]
 *   node swarm.js recall <query>
 *   node swarm.js propose "question" --options "a,b,c" --quorum 2
 *   node swarm.js vote <decisionId> <choice> [--wait 30000]
 *   node swarm.js think "question"   # ask a real model, grounded in the soul
 *   node swarm.js conflicts          # show detected conflicts + resolutions
 *   node swarm.js watch [--interval 2000] [--times 10]
 *   node swarm.js doctor          # DEEP audit: full re-hash of every chain
 *   node swarm.js demo            # spin up 3 bodies and watch quorum live
 *
 * Zero dependencies. Node 18+.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Swarm } = require('./core/swarm');

const ROOT = __dirname;

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ---------------------------------------------------------------- output

function line(char) {
  return char.repeat(64);
}

function printStatus(swarm) {
  const { state, bodies, errors, conflicts } = swarm.status();
  console.log(line('=') + ' SWARM SOUL ' + line('='));
  if (!state.soulId) {
    console.log('No soul yet. Run: node swarm.js init --name <name> --creed "<creed>"');
    return;
  }
  console.log('soulId : ' + state.soulId);
  console.log('name   : ' + state.name);
  console.log('creed  : ' + state.creed);
  console.log('head   : ' + (state.head || '').slice(0, 16) + '...');
  console.log('');
  console.log('BODIES (' + bodies.length + '):');
  for (const b of bodies) {
    const stale = b.stale ? ' [STALE]' : ' [alive]';
    const role = b.role ? ' role=' + b.role : '';
    console.log('  ' + b.bodyId + stale + role + ' events=' + b.events);
  }
  console.log('');
  console.log('MEMORIES (' + state.memories.length + '):');
  for (const m of state.memories.slice(-5).reverse()) {
    console.log('  [' + m.id.slice(0, 8) + '] ' + m.text.slice(0, 70));
  }
  console.log('');
  console.log('DECISIONS (' + state.decisions.length + '):');
  for (const d of state.decisions) {
    const votes = Object.keys(d.votes).length;
    const res = d.status === 'decided'
      ? ' DECIDED -> ' + d.result.winner
      : ' open (' + votes + '/' + d.quorum + ' votes)';
    console.log('  [' + d.id.slice(0, 8) + '] ' + d.question.slice(0, 50) + res);
  }
  if ((state.thoughts || []).length > 0) {
    console.log('');
    console.log('THOUGHTS (' + state.thoughts.length + '):');
    for (const t of state.thoughts.slice(-3).reverse()) {
      console.log('  [' + t.id.slice(0, 8) + '] Q: ' + String(t.question).slice(0, 50));
      console.log('           A: ' + String(t.answer).slice(0, 70) + '  (' + t.model + ')');
    }
  }
  if (conflicts && conflicts.length > 0) {
    console.log('');
    console.log('CONFLICTS (' + conflicts.length + ') — detected, resolved deterministically:');
    for (const c of conflicts) {
      console.log('  [' + c.kind + '] ' + c.key.slice(0, 12) + ': ' + c.detail + ' (bodies: ' + c.bodies.join(', ') + ')');
    }
  }
  if (errors.length > 0) {
    console.log('');
    console.log('CHAIN ERRORS (not trusted):');
    for (const e of errors) {
      console.log('  ' + e.bodyId + ': ' + e.error);
    }
  }
}

// ---------------------------------------------------------------- doctor

function doctor(swarm) {
  const problems = [];
  const ok = (msg) => console.log('  ok   ' + msg);
  const bad = (msg) => { problems.push(msg); console.log('  FAIL ' + msg); };

  console.log(line('=') + ' DOCTOR ' + line('='));

  // bodies dir
  if (fs.existsSync(swarm.bodiesDir)) {
    ok('bodies/ folder exists');
  } else {
    bad('bodies/ folder missing (run init)');
  }

  const { chains, errors } = swarm.chains({ full: true }); // DEEP AUDIT — trusts no checkpoint
  if (errors.length === 0) {
    ok('all ' + chains.length + ' body chains verify (FULL re-hash of every event)');
  } else {
    for (const e of errors) bad(e.bodyId + ': ' + e.error);
  }

  // v1.3: auto-repair pass — heals torn tails, drops orphaned checkpoints.
  const rep = swarm.repair();
  for (const r of rep.repaired) console.log('  fix  ' + r.bodyId + ': ' + r.reason);
  for (const q of rep.quarantined) console.log('  warn ' + q.bodyId + ': ' + q.reason);

  const { state } = swarm.fold();
  if (state.soulId) {
    ok('soul present: ' + state.name + ' (' + state.soulId + ')');
  } else {
    bad('no soul (run init)');
  }

  // every chain must carry the SAME soulId — one identity, many bodies
  const soulIds = new Set();
  for (const c of chains) {
    if (c.events.length > 0) soulIds.add(c.events[0].payload.soulId);
  }
  if (soulIds.size <= 1) {
    ok('identity unity: all bodies share one soulId');
  } else {
    bad('SPLIT BRAIN: ' + soulIds.size + ' different soulIds detected');
  }

  // stale bodies
  const { bodies } = swarm.status();
  const stale = bodies.filter((b) => b.stale);
  if (stale.length === 0) ok('all bodies fresh');
  else for (const s of stale) console.log('  warn ' + s.bodyId + ' is stale (no event in 5+ min)');

  console.log('');
  if (problems.length === 0) {
    console.log('Doctor says: SWARM IS WHOLE. One soul, ' + chains.length + ' bodies. 🦖');
  } else {
    console.log('Doctor says: ' + problems.length + ' problem(s).');
  }
  return problems.length;
}

// ---------------------------------------------------------------- demo

/**
 * Spin up three bodies on this machine, watch them converge on a decision.
 * Proves: shared identity, deterministic merge, quorum.
 */
function demo() {
  console.log(line('=') + ' SWARM DEMO: 3 bodies, 1 soul ' + line('='));
  const alpha = new Swarm(ROOT, 'body-alpha');
  const beta = new Swarm(ROOT, 'body-beta');
  const gamma = new Swarm(ROOT, 'body-gamma');

  console.log('');
  console.log('[1] Alpha comes online first and defines the soul...');
  const r1 = alpha.init('Dino Prime', 'One soul, many bodies. Stomp together.', 'elder');
  console.log('    soulId: ' + r1.soulId);

  console.log('[2] Beta and Gamma join — they must INHERIT the same identity...');
  const r2 = beta.init(null, null, 'worker');
  const r3 = gamma.init(null, null, 'worker');
  console.log('    beta  soulId: ' + r2.soulId);
  console.log('    gamma soulId: ' + r3.soulId);
  if (r1.soulId !== r2.soulId || r1.soulId !== r3.soulId) {
    throw new Error('IDENTITY SPLIT — bodies did not inherit the soul!');
  }
  console.log('    all three share ONE soulId. One identity, many bodies.');

  console.log('[3] Alpha remembers something...');
  alpha.remember('The operator likes pizza and pays in exposure-resistant currency.', ['fact']);
  console.log('    memory written to alpha chain');

  console.log('[4] Beta recalls it — memory synced through the folder bus...');
  const found = beta.recall('pizza');
  console.log('    beta found ' + found.length + ' memory: ' + (found[0] ? found[0].text.slice(0, 60) : 'NONE'));

  console.log('[5] Gamma proposes a decision, quorum 2...');
  const q = 'Which body leads the next mission?';
  const id = gamma.propose(q, ['alpha', 'beta', 'gamma'], 2);
  console.log('    decision ' + id.slice(0, 8) + ' proposed');

  console.log('[6] Alpha votes alpha, Beta votes alpha...');
  alpha.vote(id, 'alpha');
  beta.vote(id, 'alpha');
  const st = gamma.status();
  const d = st.state.decisions.find((x) => x.id === id);
  console.log('    status: ' + d.status + ', winner: ' + (d.result ? d.result.winner : 'pending'));

  console.log('[7] All three bodies heartbeat...');
  alpha.heartbeat();
  beta.heartbeat();
  gamma.heartbeat();

  console.log('[8] Final status as seen by GAMMA:');
  console.log('');
  printStatus(gamma);
  console.log('');
  console.log('Three bodies. One soul. That is Swarm Soul. 🦖💙');
}

// ---------------------------------------------------------------- main

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'help';
  const args = parseArgs(argv.slice(1));
  const swarm = new Swarm(ROOT, args.body);

  switch (cmd) {
    case 'init': {
      const r = swarm.init(args.name, args.creed, args.role);
      if (r.already) {
        console.log('Body ' + r.bodyId + ' already online (soul ' + r.soulId + ')');
      } else {
        console.log('Body ' + r.bodyId + ' online. Soul: ' + r.soulId + ' (' + swarm.fold().state.name + ')');
      }
      break;
    }
    case 'status':
      printStatus(swarm);
      break;
    case 'heartbeat': {
      const ev = swarm.heartbeat();
      console.log('heartbeat event ' + ev.i + ' appended by ' + swarm.bodyId);
      break;
    }
    case 'remember': {
      const text = args._[0];
      if (!text) throw new Error('usage: node swarm.js remember "some text" --tags a,b');
      const tags = args.tags ? String(args.tags).split(',').map((s) => s.trim()) : [];
      swarm.remember(text, tags);
      console.log('remembered: "' + text.slice(0, 60) + '"');
      break;
    }
    case 'recall': {
      const q = args._[0];
      if (!q) throw new Error('usage: node swarm.js recall <query>');
      const found = swarm.recall(q);
      console.log(found.length + ' match(es):');
      for (const m of found) console.log('  [' + m.id.slice(0, 8) + '] ' + m.text);
      break;
    }
    case 'propose': {
      const q = args._[0];
      if (!q) throw new Error('usage: node swarm.js propose "question" --options "a,b" --quorum 2');
      const options = args.options ? String(args.options).split(',').map((s) => s.trim()) : [];
      const quorum = args.quorum ? parseInt(args.quorum, 10) : 2;
      const id = swarm.propose(q, options, quorum);
      console.log('decision ' + id + ' proposed by ' + swarm.bodyId + ' (quorum ' + quorum + ')');
      break;
    }
    case 'vote': {
      const id = args._[0];
      const choice = args._[1];
      if (!id || !choice) throw new Error('usage: node swarm.js vote <decisionId> <choice> [--wait 30000]');
      swarm.vote(id, choice);
      const d = swarm.fold().state.decisions.find((x) => x.id === id);
      const votes = d ? Object.keys(d.votes).length : 0;
      console.log(swarm.bodyId + ' voted ' + choice + ' (' + votes + '/' + (d ? d.quorum : '?') + ')');
      if (d && d.status === 'decided') {
        console.log('QUORUM REACHED -> ' + d.result.winner);
      } else if (args.wait) {
        const timeout = typeof args.wait === 'string' ? parseInt(args.wait, 10) : 30000;
        console.log('quorum not reached yet — waiting for other bodies (sync speed)...');
        const dd = swarm.waitDecision(id, timeout, 1000);
        if (dd && dd.status === 'decided') {
          console.log('QUORUM REACHED -> ' + dd.result.winner);
        } else {
          console.log('still open after ' + timeout + 'ms — quorum is async; run status later or use watch');
        }
      }
      break;
    }
    case 'think': {
      const q = args._[0];
      if (!q) throw new Error('usage: node swarm.js think "question" — asks the configured model (Ollama default), grounded in the soul');
      swarm.think(q).then((r) => {
        console.log('[' + r.model + ']');
        console.log('Q: ' + r.question);
        console.log('A: ' + r.answer);
      }).catch((e) => {
        console.error('error: ' + e.message);
        process.exitCode = 1;
      });
      break;
    }
    case 'conflicts': {
      const { conflicts, resolutions } = swarm.fold();
      if (conflicts.length === 0) {
        console.log('No conflicts detected. The swarm agrees with itself. 🦖');
      } else {
        console.log(conflicts.length + ' conflict(s) detected:');
        for (const c of conflicts) {
          console.log('  [' + c.kind + '] ' + c.key.slice(0, 12) + ': ' + c.detail + ' (bodies: ' + c.bodies.join(', ') + ')');
        }
        if (resolutions.length > 0) {
          console.log('');
          console.log('Resolutions (deterministic — same on every machine):');
          for (const r of resolutions) {
            console.log('  memory ' + r.key.slice(0, 12) + ' -> winner ' + r.winnerId.slice(0, 12) + ' @ ' + r.winnerTs + ' (' + r.policy + ')');
          }
        }
      }
      break;
    }
    case 'watch': {
      const interval = args.interval ? parseInt(args.interval, 10) : 2000;
      const times = args.times ? parseInt(args.times, 10) : 0;
      console.log('watching swarm (interval ' + interval + 'ms' + (times ? ', ' + times + ' polls' : ', forever — Ctrl+C to stop') + ')...');
      swarm.watch(interval, times || undefined);
      break;
    }
    case 'doctor':
      process.exitCode = doctor(swarm) === 0 ? 0 : 1;
      break;
    case 'demo':
      demo();
      break;
    default:
      console.log(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'));
      break;
  }
}

try {
  main();
} catch (e) {
  console.error('error: ' + e.message);
  process.exitCode = 1;
}
