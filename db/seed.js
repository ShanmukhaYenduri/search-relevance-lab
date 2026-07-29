'use strict';

/**
 * Seed. Small on purpose: 20 documents with hand-graded relevance judgements in
 * eval/queries.json. A tiny corpus is the right call for a relevance harness --
 * you cannot hand-label 100k documents honestly, and unlabelled data cannot tell
 * you whether a ranking change helped.
 *
 * It is the wrong call for a *latency* claim, and I am not making one here. The
 * performance argument lives in sub-200ms-stack, which seeds 2M rows so the
 * planner has to make a real choice. Two repos because they answer two
 * different questions.
 */

const { Pool } = require('pg');
const { embedText } = require('../src/embed');

const DOCS = [
  {
    id: 1,
    title: "PostgreSQL full-text search with tsvector and GIN",
    body: "A tsvector column plus a GIN index turns a scan over every row into a posting-list lookup. The generated-column form cannot drift from the row it describes.",
    popularity: 940,
    tags: ['postgres','fts'],
  },
  {
    id: 2,
    title: "Weighting titles above bodies in a tsvector",
    body: "setweight lets a title match outrank a body match inside the index itself, so the application never needs a hand-tuned multiplier to compensate.",
    popularity: 610,
    tags: ['postgres','ranking'],
  },
  {
    id: 3,
    title: "Ranking with ts_rank_cd and what the normalisation flags do",
    body: "Cover density ranking rewards documents where the query terms appear close together. Flag 32 bounds the score into zero to one, which only matters when a human reads it.",
    popularity: 520,
    tags: ['ranking','postgres'],
  },
  {
    id: 4,
    title: "Reading an EXPLAIN ANALYZE plan without guessing",
    body: "Start at the innermost node and compare estimated rows against actual. A large gap means the planner is working from bad statistics, and no amount of index tuning fixes that.",
    popularity: 880,
    tags: ['postgres','performance'],
  },
  {
    id: 5,
    title: "Why the planner ignored your index",
    body: "Function calls on the indexed column, a type mismatch in the predicate, or an ORDER BY the operator class cannot satisfy. All three produce a correct answer and a sequential scan.",
    popularity: 1210,
    tags: ['postgres','performance'],
  },
  {
    id: 6,
    title: "Budgeting latency per hop before you write the code",
    body: "Decide what each hop is allowed to spend while the design is still on a whiteboard. Retrofitting a budget onto a finished service means renegotiating every decision at once.",
    popularity: 700,
    tags: ['latency','architecture'],
  },
  {
    id: 7,
    title: "Cache invalidation as a design step, not an afterthought",
    body: "If you cannot name the write that clears a key, you do not have a cache, you have a bug on a delay.",
    popularity: 1330,
    tags: ['caching'],
  },
  {
    id: 8,
    title: "TTLs, versioned keys, and bounded staleness",
    body: "A version prefix makes invalidation a single increment instead of a fan-out of deletes, and every key still carries a TTL as the backstop.",
    popularity: 560,
    tags: ['caching'],
  },
  {
    id: 9,
    title: "Measuring p95 instead of averages",
    body: "An average hides the tail, and the tail is what users complain about. Alert on the percentile you promised, not the one that looks calm.",
    popularity: 760,
    tags: ['latency','observability'],
  },
  {
    id: 10,
    title: "A log is not a queue: choosing Kafka on purpose",
    body: "A queue gives one consumer one shot at a message. A log lets independent consumers read the same events at their own pace and replay them after a bad deploy.",
    popularity: 1020,
    tags: ['kafka','architecture'],
  },
  {
    id: 11,
    title: "Consumer groups, replay, and what breaks after a bad deploy",
    body: "Offsets are the recovery story. If the fix is to reprocess yesterday, the design decision that made it possible was made months earlier.",
    popularity: 430,
    tags: ['kafka'],
  },
  {
    id: 12,
    title: "Prefix autocomplete that stays under ten milliseconds",
    body: "The keystroke path has a budget measured in single-digit milliseconds, which rules out anything that sorts a large candidate set per request.",
    popularity: 890,
    tags: ['search','autocomplete'],
  },
  {
    id: 13,
    title: "Ranked tries: caching the best completions per node",
    body: "Each node keeps the top completions of its own subtree, so lookup walks the typed characters and then reads an already-sorted list.",
    popularity: 470,
    tags: ['search','autocomplete'],
  },
  {
    id: 14,
    title: "Debouncing the keystroke path without making it feel laggy",
    body: "Cancel in flight requests instead of waiting longer. The perceived delay comes from the last response, not the first.",
    popularity: 380,
    tags: ['frontend','autocomplete'],
  },
  {
    id: 15,
    title: "text_pattern_ops, collations, and index-usable LIKE",
    body: "A trailing wildcard can use a B-tree; a leading wildcard has no prefix to seek on and never will, no matter how you index it.",
    popularity: 640,
    tags: ['postgres','search'],
  },
  {
    id: 16,
    title: "Blending relevance with popularity without burying new documents",
    body: "Popularity is a ranking signal, never a filter. Used as a multiplier it quietly guarantees that nothing new is ever discovered.",
    popularity: 720,
    tags: ['ranking'],
  },
  {
    id: 17,
    title: "Freshness decay as a ranking signal",
    body: "Recency should tilt a close call, not overturn a clear one. That means a bounded decay term, not a sort key.",
    popularity: 340,
    tags: ['ranking'],
  },
  {
    id: 18,
    title: "pgvector, HNSW, and approximate nearest neighbour",
    body: "HNSW trades a little recall for a lot of latency, and unlike IVFFlat it does not ask you to pick a list count before the data exists.",
    popularity: 980,
    tags: ['vector','search'],
  },
  {
    id: 19,
    title: "Cosine distance, normalisation, and why direction is all that matters",
    body: "Normalise once at write time. Skipping it makes long documents look systematically closer to every query.",
    popularity: 510,
    tags: ['vector'],
  },
  {
    id: 20,
    title: "Reciprocal Rank Fusion: combining two rankers without tuning",
    body: "Fusing on rank sidesteps the fact that a lexical score and a cosine similarity are not on a comparable scale and never will be.",
    popularity: 860,
    tags: ['ranking','search'],
  },
];

// Head terms for the autocomplete trie, with the hit counts that order them.
// In production this table is a rollup of the real query log; here it is a
// plausible stand-in so the demo ranks something other than alphabetically.
const TERMS = [
  { term: "postgres full text search", hits: 4200 },
  { term: "postgres index", hits: 3100 },
  { term: "postgres explain", hits: 1500 },
  { term: "p95 latency", hits: 1400 },
  { term: "prefix autocomplete", hits: 1200 },
  { term: "kafka consumer group", hits: 1100 },
  { term: "kafka vs queue", hits: 980 },
  { term: "cache invalidation", hits: 2600 },
  { term: "cache ttl", hits: 1700 },
  { term: "cosine similarity", hits: 900 },
  { term: "vector search", hits: 2300 },
  { term: "vector index hnsw", hits: 640 },
  { term: "ranking signals", hits: 580 },
  { term: "rank search results", hits: 520 },
  { term: "reciprocal rank fusion", hits: 310 },
  { term: "tsvector", hits: 260 },
  { term: "trigram similarity", hits: 240 },
  { term: "text pattern ops", hits: 130 },
];

async function main() {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      'postgres://search:search@localhost:5432/search',
  });

  const client = await pool.connect();
  try {
    // One transaction: a half-seeded corpus would silently invalidate every
    // number the eval harness prints afterwards.
    await client.query('BEGIN');
    await client.query('TRUNCATE documents, query_log RESTART IDENTITY');

    for (const d of DOCS) {
      // Embed title and body together. Embedding the title alone is a common
      // shortcut and it throws away most of the signal you were paying for.
      const embedding = embedText(d.title + ' ' + d.body);
      await client.query(
        `INSERT INTO documents (id, title, body, tags, popularity, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)`,
        [d.id, d.title, d.body, d.tags, d.popularity, '[' + embedding.join(',') + ']'],
      );
    }

    for (const t of TERMS) {
      await client.query(
        'INSERT INTO query_log (term, hits) VALUES ($1, $2)',
        [t.term, t.hits],
      );
    }

    // Sequence has to be moved past the explicit ids, or the first insert from
    // the API collides with a seeded row. Easy to forget, annoying to debug.
    await client.query("SELECT setval('documents_id_seq', (SELECT MAX(id) FROM documents))");
    await client.query('COMMIT');

    // The planner needs statistics before any plan it produces is worth
    // reading, and ANALYZE cannot run usefully inside the same transaction.
    await client.query('ANALYZE documents');
    await client.query('ANALYZE query_log');

    console.log('seeded ' + DOCS.length + ' documents and ' + TERMS.length + ' terms');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
