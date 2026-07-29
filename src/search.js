'use strict';

/**
 * Retrieval. Four strategies over the same table so they can be argued about
 * with numbers instead of opinions:
 *
 *   keyword()  lexical, tsvector + GIN. Wins on rare tokens, identifiers, error
 *              codes, product SKUs -- anything where the exact string matters.
 *   fuzzy()    trigram similarity. Wins on typos and half-remembered names.
 *   semantic() cosine ANN over embeddings. Wins on paraphrase and intent,
 *              loses badly on rare exact tokens it has never seen.
 *   hybrid()   fuses keyword + semantic by rank, which is the version I would
 *              actually ship.
 *
 * Every function returns { id, title, score } with bigger meaning better, so
 * the fusion step and the eval harness do not need per-strategy special cases.
 */

// Reciprocal Rank Fusion constant. 60 is the value from the original TREC work
// and it is deliberately not tuned here: the point of RRF is that it works
// without a tuning budget. If I tuned it, I would have to justify it against a
// held-out query set, and eval/ is where that argument would happen.
const RRF_K = 60;

const toVector = (arr) => '[' + arr.join(',') + ']';

/**
 * Lexical search.
 *
 * websearch_to_tsquery, not plainto_tsquery: it understands quoted phrases and
 * leading-minus negation, which is what people actually type into a box. It
 * also does not throw on syntax the user got wrong, which matters when the
 * input is a text field on the internet.
 *
 * ts_rank_cd with normalisation flag 32 divides by (rank + 1), which bounds the
 * score into (0, 1). Useful when a human reads the numbers; irrelevant to the
 * ordering.
 */
async function keyword(pool, q, limit = 20) {
  const { rows } = await pool.query(
    `SELECT d.id, d.title, ts_rank_cd(d.tsv, query, 32) AS score
       FROM documents d, websearch_to_tsquery('english', $1) AS query
      WHERE d.tsv @@ query
      ORDER BY score DESC, d.popularity DESC, d.id
      LIMIT $2`,
    [q, limit],
  );
  return rows;
}

/**
 * Typo tolerance.
 *
 * The `%` operator is what lets the GIN trigram index supply candidates; the
 * similarity() in the select list is only there to score them. Writing this as
 * ORDER BY similarity(...) DESC with no WHERE would compute similarity for
 * every row in the table and sort the lot -- correct answers, sequential scan.
 *
 * Threshold comes from pg_trgm.similarity_threshold. Raising it costs recall on
 * real typos; lowering it lets 'cat' match 'catalogue' and quietly destroys
 * precision. That number belongs in a config file with a comment, not inline.
 */
async function fuzzy(pool, q, limit = 20) {
  const { rows } = await pool.query(
    `SELECT d.id, d.title, similarity(d.title, $1) AS score
       FROM documents d
      WHERE d.title % $1
      ORDER BY score DESC, d.popularity DESC, d.id
      LIMIT $2`,
    [q, limit],
  );
  return rows;
}

/**
 * Semantic search.
 *
 * The one thing that is easy to get wrong here: ORDER BY has to be on the raw
 * distance operator. If you order by the derived similarity (1 - distance) the
 * planner can no longer match the ORDER BY to the HNSW operator class, the
 * index is skipped, and you get an exact scan that is correct and slow. Ask me
 * how I know.
 */
async function semantic(pool, embedding, limit = 20) {
  const { rows } = await pool.query(
    `SELECT d.id, d.title, 1 - (d.embedding <=> $1::vector) AS score
       FROM documents d
      WHERE d.embedding IS NOT NULL
      ORDER BY d.embedding <=> $1::vector
      LIMIT $2`,
    [toVector(embedding), limit],
  );
  return rows;
}

/**
 * Reciprocal Rank Fusion.
 *
 * Why fuse on rank instead of normalising the scores: ts_rank_cd and cosine
 * similarity are not on a comparable scale and never will be. Min-max
 * normalising them per query looks principled and is not -- one outlier moves
 * every other score in the list. Ranks are already comparable, which is the
 * whole idea.
 */
function rrf(lists, { k = RRF_K, limit = 20 } = {}) {
  const acc = new Map();
  for (const list of lists) {
    list.forEach((row, i) => {
      const cur = acc.get(row.id) || { ...row, score: 0, sources: 0 };
      cur.score += 1 / (k + i + 1);
      cur.sources += 1;
      acc.set(row.id, cur);
    });
  }
  return [...acc.values()]
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, limit);
}

/**
 * What I would ship.
 *
 * Both candidate generators run concurrently -- they hit different indexes and
 * neither depends on the other, so serialising them would just add the smaller
 * latency to the larger for no reason. Over-fetch by 3x before fusing, because
 * a document ranked 40th by keyword and 5th by vector is exactly the result
 * hybrid retrieval exists to surface, and it is invisible if each leg only
 * returns 20.
 */
async function hybrid(pool, { q, embedding, limit = 20 }) {
  const legs = [keyword(pool, q, limit * 3)];
  if (embedding) legs.push(semantic(pool, embedding, limit * 3));

  const results = await Promise.all(legs);
  const fused = rrf(results, { limit });

  // Nothing matched lexically or semantically: the query is probably misspelled,
  // so fall back rather than returning an empty page.
  if (fused.length === 0) return fuzzy(pool, q, limit);
  return fused;
}

/**
 * Used by the eval harness and by me, every time I touch a query. A plan is the
 * only way to know whether the index I added is the index being used -- timings
 * alone will happily hide a sequential scan on a warm 2k-row test table.
 */
async function explain(pool, sql, params) {
  const { rows } = await pool.query(
    'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ' + sql,
    params,
  );
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

module.exports = { keyword, fuzzy, semantic, hybrid, rrf, explain, RRF_K };
