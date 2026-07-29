'use strict';

/**
 * Offline relevance harness.
 *
 * The reason this file exists: you cannot tell whether a ranking change helped
 * by looking at one query and nodding. Relevance work without a query set and a
 * metric is just moving weights around until the demo query looks good, and it
 * reliably makes every other query worse.
 *
 * Metrics, and why each one is here:
 *
 *   P@k    what fraction of the top k is any good. What a user feels.
 *   R@k    what fraction of everything good made it into the top k. Catches a
 *          ranker that is precise because it is timid.
 *   MRR    how far down the first good result sits. Proxy for 'I found it
 *          immediately', and the metric that moves when autocomplete is bad.
 *   nDCG@k the only one that uses the *grades* rather than treating relevance
 *          as a yes/no. A 3 at rank 1 and a 1 at rank 1 are not the same
 *          outcome, and the other three metrics cannot tell them apart.
 *
 * Grades live in eval/queries.json as { docId: grade }, 3 down to 1. The empty
 * query is in the set on purpose: a ranker that throws on no-match input is
 * broken in a way that averages will hide.
 */

const { Pool } = require('pg');
const { keyword, fuzzy, semantic, hybrid } = require('../src/search');
const { embedText } = require('../src/embed');
const QUERIES = require('./queries.json');

const K = 5;

const gradeOf = (judgements, id) => judgements[String(id)] || 0;

function precisionAt(results, judgements, k) {
  const top = results.slice(0, k);
  if (top.length === 0) return 0;
  const hits = top.filter((r) => gradeOf(judgements, r.id) > 0).length;
  return hits / top.length;
}

function recallAt(results, judgements, k) {
  const total = Object.keys(judgements).length;
  if (total === 0) return 1; // nothing to find, so nothing was missed
  const hits = results.slice(0, k).filter((r) => gradeOf(judgements, r.id) > 0).length;
  return hits / total;
}

function reciprocalRank(results, judgements) {
  const at = results.findIndex((r) => gradeOf(judgements, r.id) > 0);
  return at === -1 ? 0 : 1 / (at + 1);
}

/**
 * Discounted cumulative gain over the ideal ordering.
 *
 * The log2 discount is the standard one. The part worth stating out loud is the
 * ideal DCG in the denominator: without it, a query with six relevant documents
 * scores higher than a query with one, and averaging across a query set becomes
 * meaningless.
 */
function ndcgAt(results, judgements, k) {
  const dcg = results
    .slice(0, k)
    .reduce((sum, r, i) => sum + gradeOf(judgements, r.id) / Math.log2(i + 2), 0);

  const ideal = Object.values(judgements)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);

  return ideal === 0 ? 1 : dcg / ideal;
}

const STRATEGIES = {
  keyword: (pool, q) => keyword(pool, q.query, 20),
  fuzzy: (pool, q) => fuzzy(pool, q.query, 20),
  semantic: (pool, q) => semantic(pool, embedText(q.query), 20),
  hybrid: (pool, q) => hybrid(pool, { q: q.query, embedding: embedText(q.query), limit: 20 }),
};

async function main() {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      'postgres://search:search@localhost:5432/search',
  });

  const table = [];

  for (const [name, run] of Object.entries(STRATEGIES)) {
    const acc = { p: 0, r: 0, mrr: 0, ndcg: 0 };

    for (const q of QUERIES) {
      // A strategy that throws on one query scores zero on that query rather
      // than killing the run. Partial results still tell you something; a stack
      // trace halfway through the query set tells you nothing.
      let results = [];
      try {
        results = await run(pool, q);
      } catch (err) {
        console.error('[' + name + '] query ' + q.id + ' failed: ' + err.message);
      }
      acc.p += precisionAt(results, q.relevant, K);
      acc.r += recallAt(results, q.relevant, K);
      acc.mrr += reciprocalRank(results, q.relevant);
      acc.ndcg += ndcgAt(results, q.relevant, K);
    }

    const n = QUERIES.length;
    table.push({
      strategy: name,
      ['P@' + K]: (acc.p / n).toFixed(3),
      ['R@' + K]: (acc.r / n).toFixed(3),
      MRR: (acc.mrr / n).toFixed(3),
      ['nDCG@' + K]: (acc.ndcg / n).toFixed(3),
    });
  }

  console.table(table);
  console.log(
    '\n' + QUERIES.length + ' queries, k=' + K + '. Numbers on a 20-document corpus are');
  console.log(
    'directional, not publishable -- the point is the delta when you change a');
  console.log('ranker, and the fact that the delta is measured at all.');

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
