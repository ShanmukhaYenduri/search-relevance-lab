'use strict';

/**
 * Ranked prefix trie for autocomplete.
 *
 * Why this exists when Postgres can already answer LIKE 'pre%':
 *
 *   LIKE 'pre%' against a text_pattern_ops index IS an index range scan, so it
 *   is not slow. What it is not is *ranked*. You still have to sort every match
 *   by popularity, and a hot prefix like "in" can match thousands of terms --
 *   on every keystroke. Autocomplete has a single-digit-millisecond budget and a
 *   corpus small enough to hold in memory. That combination is what makes a
 *   trie the right tool here. Not trie-worship: the same code against a 50M-row
 *   term table would be the wrong call, and I would use the index scan.
 *
 * The move that makes lookup O(k) instead of O(k + subtree):
 *
 *   every node caches the best FANOUT completions of its own subtree, so a
 *   lookup walks k characters and then reads an already-sorted array. Insertion
 *   pays for that instead -- each insert touches only the k nodes on its own
 *   path. k is the length of what the user has typed, so it is small and
 *   bounded by construction.
 *
 * Honest limitation, stated up front:
 *
 *   the top-N cache is only correct for monotonically increasing hit counts. A
 *   term that was evicted from a node's top-N cannot climb back without a
 *   rebuild. So seeds load in descending hit order, and the trie is rebuilt on
 *   the same schedule as the query-log rollup. That is a bounded staleness
 *   window I chose deliberately, which is the same discipline as the cache TTLs
 *   in sub-200ms-stack: if I cannot name what makes it correct again, I do not
 *   ship it.
 */

const FANOUT = 10;

const normalise = (s) => String(s).toLowerCase().trim().replace(/\s+/g, ' ');

class TrieNode {
  constructor() {
    this.children = new Map();
    this.best = []; // [{ term, hits }], sorted by hits desc, length <= fanout
  }
}

class RankedTrie {
  constructor(fanout = FANOUT) {
    this.root = new TrieNode();
    this.fanout = fanout;
    this.terms = new Map(); // term -> hits, so callers can read exact counts
  }

  /** O(k * fanout). k = term length. */
  insert(term, hits = 1) {
    const key = normalise(term);
    if (!key) return this;
    this.terms.set(key, hits);

    let node = this.root;
    this.#offer(node, key, hits);
    for (const ch of key) {
      let next = node.children.get(ch);
      if (!next) {
        next = new TrieNode();
        node.children.set(ch, next);
      }
      node = next;
      this.#offer(node, key, hits);
    }
    return this;
  }

  /** Bulk load. Sorts desc first so the top-N caches are correct in one pass. */
  load(pairs) {
    [...pairs]
      .sort((a, b) => (b.hits || 0) - (a.hits || 0))
      .forEach(({ term, hits }) => this.insert(term, hits));
    return this;
  }

  /** O(k + limit). This is the call that sits on the keystroke path. */
  complete(prefix, limit = 5) {
    const key = normalise(prefix);
    let node = this.root;
    for (const ch of key) {
      node = node.children.get(ch);
      if (!node) return []; // dead prefix: hand off to trigram search, see src/search.js
    }
    return node.best.slice(0, limit).map((e) => ({ ...e }));
  }

  #offer(node, term, hits) {
    const at = node.best.findIndex((e) => e.term === term);
    if (at !== -1) {
      if (node.best[at].hits >= hits) return;
      node.best.splice(at, 1);
    } else if (
      node.best.length >= this.fanout &&
      hits <= node.best[node.best.length - 1].hits
    ) {
      return; // cannot make the cut, so do not pay to insert it
    }

    // Ties break lexicographically so results are stable between runs --
    // a flapping suggestion list is indistinguishable from a bug in a demo.
    let i = 0;
    while (
      i < node.best.length &&
      (node.best[i].hits > hits ||
        (node.best[i].hits === hits && node.best[i].term < term))
    ) {
      i++;
    }
    node.best.splice(i, 0, { term, hits });
    if (node.best.length > this.fanout) node.best.pop();
  }
}

module.exports = { RankedTrie, normalise };
