'use strict';

/**
 * Embeddings, with an honest caveat.
 *
 * embedText() here is NOT a semantic model. It is feature hashing over token
 * unigrams and bigrams, L2-normalised into the same 384 dimensions pgvector is
 * configured for. That choice is deliberate:
 *
 *   - the repo has to clone-and-run with no API key and no model download, or
 *     nobody will ever actually run it;
 *   - it makes the vector *plumbing* real and testable end to end -- the HNSW
 *     index, the operator class, the ORDER BY gotcha in src/search.js, the RRF
 *     fusion, the eval harness;
 *   - and it is a stand-in I can name precisely rather than a black box I am
 *     hand-waving about.
 *
 * What it does capture: lexical overlap, with a bit of word-order signal from
 * the bigrams. What it does not capture: meaning. It will not put 'car' near
 * 'automobile', which is the entire reason semantic search exists.
 *
 * To make it real, replace the body of embedText() with a call to a sentence
 * transformer (all-MiniLM-L6-v2 is 384-dim, which is why the schema says 384)
 * or any embedding API. Nothing else in this repo changes -- not the schema,
 * not the queries, not the fusion, not the eval. That is the point of keeping
 * the seam here instead of inlining a client call into the search path.
 */

const DIMS = 384;

const tokenise = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

// FNV-1a. Cheap, well-distributed, and deterministic across processes -- which
// matters, because an embedding that changes between the seed run and the query
// run would produce silently garbage results.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function embedText(text) {
  const vec = new Float64Array(DIMS);
  const tokens = tokenise(text);

  const features = [...tokens];
  for (let i = 0; i + 1 < tokens.length; i++) {
    features.push(tokens[i] + '_' + tokens[i + 1]);
  }

  for (const f of features) {
    const h = hash(f);
    // Signed hashing: the low bit picks the sign, so collisions cancel out on
    // average instead of always adding up. Standard hashing-trick detail that
    // is easy to leave out and measurably worse without.
    vec[h % DIMS] += (h & 1) === 0 ? 1 : -1;
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return Array.from(vec);

  // Normalise, because the schema indexes with vector_cosine_ops and cosine
  // only cares about direction. Skipping this makes long documents look
  // systematically closer to everything.
  return Array.from(vec, (v) => v / norm);
}

module.exports = { embedText, DIMS, tokenise };
