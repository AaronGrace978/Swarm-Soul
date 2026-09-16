/**
 * SWARM SOUL — core/mind.js
 * The mind: a body that can THINK.
 *
 * v1.3 — ACTUAL MODEL INTEGRATION. The harness had a soul, memories,
 * and quorum — but no mind. Now a body can ask a real model a question
 * grounded in the soul's state (creed, memories, open decisions), and
 * the answer is appended to the chain as a 'thought' event. Thinking
 * joins the soul and syncs like everything else.
 *
 * Providers (zero dependencies — Node 18+ global fetch):
 *   ollama — local models via Ollama's HTTP API (default:
 *            http://localhost:11434). Private, offline, yours.
 *   openai — any OpenAI-compatible cloud or local server: OpenAI,
 *            OpenRouter, Groq, Together, LM Studio, llama.cpp server.
 *            Point SWARM_MIND_URL at it, SWARM_MIND_API_KEY if needed.
 *
 * Configuration (env):
 *   SWARM_MIND_PROVIDER  ollama | openai          (default ollama)
 *   SWARM_MIND_URL       base URL of the endpoint (default per provider)
 *   SWARM_MIND_MODEL     model name               (default llama3.1 / gpt-4o-mini)
 *   SWARM_MIND_API_KEY   bearer token             (cloud providers)
 *
 * The soul-state IS the context: any model plugged into any body
 * speaks as the same identity. One soul, many bodies, any mind.
 */

'use strict';

const DEFAULTS = {
  ollama: { url: 'http://localhost:11434', model: 'llama3.1' },
  openai: { url: 'https://api.openai.com', model: 'gpt-4o-mini' },
};

const PROBE_TIMEOUT_MS = 4000;
const GENERATE_TIMEOUT_MS = 120000;

/** AbortController-based timeout — zero-dep, Node 18 fetch honors signals. */
function timeoutSignal(ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, cancel: () => clearTimeout(timer) };
}

class Mind {
  constructor(opts) {
    opts = opts || {};
    this.provider = opts.provider || 'ollama';
    if (!DEFAULTS[this.provider]) {
      throw new Error('mind: unknown provider "' + this.provider + '" (use: ollama | openai)');
    }
    this.baseUrl = String(opts.baseUrl || DEFAULTS[this.provider].url).replace(/\/+$/, '');
    this.model = opts.model || DEFAULTS[this.provider].model;
    this.apiKey = opts.apiKey || null;
    if (this.provider === 'openai' && !this.apiKey) {
      throw new Error('mind: cloud provider needs SWARM_MIND_API_KEY (or use the default local ollama provider)');
    }
  }

  /** Build from environment — the one true config path for CLI usage. */
  static fromEnv() {
    return new Mind({
      provider: process.env.SWARM_MIND_PROVIDER,
      baseUrl: process.env.SWARM_MIND_URL,
      model: process.env.SWARM_MIND_MODEL,
      apiKey: process.env.SWARM_MIND_API_KEY,
    });
  }

  /** Human-readable identity of this mind, e.g. ollama:llama3.1@http://localhost:11434 */
  describe() {
    return this.provider + ':' + this.model + '@' + this.baseUrl;
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = 'Bearer ' + this.apiKey;
    return h;
  }

  /**
   * Reachability probe — answers "is there a mind here?" honestly.
   * ollama: GET /api/tags (lists installed models).
   * openai: GET /v1/models (lists served models).
   */
  async probe() {
    const url = this.provider === 'ollama'
      ? this.baseUrl + '/api/tags'
      : this.baseUrl + '/v1/models';
    const to = timeoutSignal(PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: to.signal, headers: this._headers() });
      if (!res.ok) return { reachable: false, detail: 'HTTP ' + res.status };
      let detail = 'reachable';
      try {
        const j = await res.json();
        if (this.provider === 'ollama' && Array.isArray(j.models)) {
          detail = j.models.length + ' model(s) installed';
        } else if (this.provider === 'openai' && Array.isArray(j.data)) {
          detail = j.data.length + ' model(s) served';
        }
      } catch (e) {
        // body not JSON — still reachable, that's what matters
      }
      return { reachable: true, detail: detail };
    } catch (e) {
      const why = e && e.name === 'AbortError' ? 'timeout after ' + PROBE_TIMEOUT_MS + 'ms' : 'unreachable';
      return { reachable: false, detail: why };
    } finally {
      to.cancel();
    }
  }

  /** Generate an answer given a system prompt (the soul's context) and a question. */
  async generate(system, prompt) {
    if (this.provider === 'ollama') return this._generateOllama(system, prompt);
    return this._generateOpenAI(system, prompt);
  }

  async _generateOllama(system, prompt) {
    const to = timeoutSignal(GENERATE_TIMEOUT_MS);
    try {
      const res = await fetch(this.baseUrl + '/api/generate', {
        method: 'POST',
        headers: this._headers(),
        signal: to.signal,
        body: JSON.stringify({
          model: this.model,
          system: system,
          prompt: prompt,
          stream: false,
        }),
      });
      if (!res.ok) {
        throw new Error('ollama HTTP ' + res.status + ' — is the model pulled? try: ollama pull ' + this.model);
      }
      const j = await res.json();
      const text = String(j.response || '').trim();
      if (!text) throw new Error('ollama returned an empty response');
      return text;
    } finally {
      to.cancel();
    }
  }

  async _generateOpenAI(system, prompt) {
    const to = timeoutSignal(GENERATE_TIMEOUT_MS);
    try {
      const res = await fetch(this.baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: this._headers(),
        signal: to.signal,
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error('mind HTTP ' + res.status + ' — check SWARM_MIND_URL / SWARM_MIND_API_KEY / SWARM_MIND_MODEL');
      }
      const j = await res.json();
      const choice = (j.choices || [])[0] || {};
      const text = String(((choice.message || {}).content) || '').trim();
      if (!text) throw new Error('empty completion from ' + this.describe());
      return text;
    } finally {
      to.cancel();
    }
  }
}

module.exports = { Mind: Mind };
