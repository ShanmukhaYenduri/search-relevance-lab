'use strict';

/**
 * HTTP surface. Two endpoints, because search and autocomplete have different
 * latency budgets and therefore different implementations:
 *
 *   GET /search        strategy switchable, so the tradeoffs in the README can
 *                      be reproduced from a browser instead of taken on trust.
 *   GET /autocomplete  in-memory trie, single-digit ms, no database round trip
 *                      on the keystroke path at all.
 */

const express = require('express');
const { Pool } = require('pg');
const { keyword, fuzzy, semantic, hybrid } = require('./search');
const { embedText } = require('./embed');
const { RankedTrie } = require('./trie');

const PORT = Number(process.env.PORT || 3000);

// Per-hop budgets, in code rather than in a design document nobody opens again.
// Exceeding one is logged with the query so it can be found later; the request
// still succeeds, because a slow correct answer beats a fast error.
const BUDGET_MS = { search: 200, autocomplete: 10 };

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://search:search@localhost:5432/search',
  max: 10,
  // Fail fast on checkout. A request queueing forever behind an exhausted pool
  // is indistinguishable from a hang to the caller, and it burns the budget of
  // every retry behind it.
  connectionTimeoutMillis: 2000,
  // Server-side ceiling, so a pathological query cannot outlive the request
  // that asked for it.
  statement_timeout: 5000,
});

const trie = new RankedTrie();

async function loadTrie() {
  const { rows } = await pool.query('SELECT term, hits FROM query_log');
  trie.load(rows.map((r) => ({ term: r.term, hits: Number(r.hits) })));
  return rows.length;
}

const app = express();
app.disable('x-powered-by');

const timed = (label, handler) => async (req, res, next) => {
  const started = process.hrtime.bigint();
  try {
    const body = await handler(req, res);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms > BUDGET_MS[label]) {
      console.warn(
        JSON.stringify({ level: 'warn', event: 'over_budget', route: label, ms: +ms.toFixed(1), budget_ms: BUDGET_MS[label], q: req.query.q }),
      );
    }
    res.set('Server-Timing', label + ';dur=' + ms.toFixed(1));
    res.json({ ...body, took_ms: +ms.toFixed(1) });
  } catch (err) {
    next(err);
  }
};

app.get(
  '/search',
  timed('search', async (req) => {
    const q = String(req.query.q || '').trim();
    const strategy = String(req.query.strategy || 'hybrid');
    const limit = Math.min(Number(req.query.limit) || 10, 50);

    // An empty query is a user event, not an error. Returning 400 here means
    // every consumer has to special-case the first render of a search page.
    if (!q) return { query: q, strategy, results: [] };

    const run = {
      keyword: () => keyword(pool, q, limit),
      fuzzy: () => fuzzy(pool, q, limit),
      semantic: () => semantic(pool, embedText(q), limit),
      hybrid: () => hybrid(pool, { q, embedding: embedText(q), limit }),
    }[strategy];

    if (!run) {
      const e = new Error('unknown strategy: ' + strategy);
      e.status = 400;
      throw e;
    }

    return { query: q, strategy, results: await run() };
  }),
);

app.get(
  '/autocomplete',
  timed('autocomplete', async (req) => {
    const prefix = String(req.query.q || '');
    const limit = Math.min(Number(req.query.limit) || 5, 20);
    const suggestions = trie.complete(prefix, limit);

    // Dead prefix: almost always a typo. Hand off to trigram similarity rather
    // than showing an empty dropdown, which reads as 'nothing exists'.
    if (suggestions.length === 0 && prefix.trim().length > 2) {
      const rows = await fuzzy(pool, prefix, limit);
      return { prefix, source: 'trigram-fallback', suggestions: rows };
    }
    return { prefix, source: 'trie', suggestions };
  }),
);

// Liveness only. It deliberately does not touch Postgres: if the database is
// down, restarting this process does not help, and a health check that fails on
// a dependency outage turns one incident into a restart loop on top of it.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Readiness is the one that checks dependencies, because that answer changes
// whether traffic should be routed here.
app.get('/readyz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ready: true, terms: trie.terms.size });
  } catch (err) {
    res.status(503).json({ ready: false, error: err.message });
  }
});

app.use((err, req, res, next) => {
  console.error(JSON.stringify({ level: 'error', msg: err.message }));
  res.status(err.status || 500).json({ error: err.message });
});

loadTrie()
  .then((n) => {
    const server = app.listen(PORT, () =>
      console.log('listening on ' + PORT + ', trie loaded with ' + n + ' terms'));

    // Drain in-flight requests before dropping the pool, otherwise a deploy
    // shows up as a handful of 502s that nobody can reproduce afterwards.
    const shutdown = () => {
      server.close(async () => {
        await pool.end();
        process.exit(0);
      });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })
  .catch((err) => {
    console.error('failed to warm the trie: ' + err.message);
    process.exit(1);
  });
