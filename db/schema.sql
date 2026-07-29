-- search-relevance-lab :: schema
-- Three retrieval strategies over one table, so they can be compared on the
-- same data with the same query set:
--   1. lexical   tsvector + GIN     exact terms, rare tokens, identifiers
--   2. fuzzy     pg_trgm + GIN      typos, transpositions, partial names
--   3. semantic  pgvector + HNSW    paraphrase, synonym, intent
--
-- None of this needs a separate search cluster. That is the whole point of the
-- first tradeoff in the README.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

DROP TABLE IF EXISTS documents;

CREATE TABLE documents (
    id           BIGSERIAL PRIMARY KEY,
    title        TEXT        NOT NULL,
    body         TEXT        NOT NULL,
    tags         TEXT[]      NOT NULL DEFAULT '{}',
    -- click count: a ranking signal, never a filter
    popularity   INTEGER     NOT NULL DEFAULT 0,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Generated, not trigger-maintained, so the index can never drift from the
    -- row it describes. Title is weighted A and body B, which is why a title
    -- match outranks a body match without any application-side fudge factor.
    tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(body,  '')), 'B')
    ) STORED,

    -- 384 dims: all-MiniLM-L6-v2. Nullable on purpose -- the lexical path has
    -- to keep serving while an embedding backfill is still running.
    embedding vector(384)
);

-- The inverted index. This is the line that turns "read every row" into
-- "walk a posting list".
CREATE INDEX documents_tsv_gin ON documents USING GIN (tsv);

-- Trigrams, for similarity(). Needed because a leading wildcard has no prefix
-- to seek on, so LIKE '%term%' can never use a B-tree no matter how you index.
CREATE INDEX documents_title_trgm ON documents USING GIN (title gin_trgm_ops);

-- Approximate nearest neighbour. Cosine because the embeddings are normalised
-- and only direction carries meaning. HNSW over IVFFlat here: better recall at
-- low latency, and no need to pick a list count before the data exists.
CREATE INDEX documents_embedding_hnsw ON documents
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Autocomplete source of truth. text_pattern_ops so that LIKE 'pre%' is an
-- index range scan under any collation. src/trie.js is the in-memory version
-- of this same lookup, and eval/ compares the two on latency and on ranking.
CREATE TABLE query_log (
    term TEXT PRIMARY KEY,
    hits INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX query_log_term_prefix ON query_log (term text_pattern_ops);

-- Plans are only trustworthy after the planner has statistics.
ANALYZE documents;
