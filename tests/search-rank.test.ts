import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cosineSimilarity,
  decodeVector,
  dedupeAgainstExact,
  encodeVector,
  rankBySimilarity,
} from "../lib/search-rank.ts";

test("encode/decode round-trips a vector through the float32 BLOB format", () => {
  const values = [0.25, -1.5, 0, 3.125]; // exactly representable in f32
  const decoded = decodeVector(encodeVector(values));
  assert.deepEqual(Array.from(decoded), values);
});

test("cosine similarity: identical=1, orthogonal=0, opposite=-1", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-6);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
});

test("cosine similarity: mismatched lengths and zero vectors are 0, never NaN", () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 2]), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

const index = [
  { source: "task", refId: "1", text: "book flight to NYC", vector: new Float32Array([1, 0, 0]) },
  { source: "task", refId: "2", text: "water the plants", vector: new Float32Array([0, 1, 0]) },
  { source: "mail", refId: "9", text: "Your itinerary — Delta", vector: new Float32Array([0.9, 0.1, 0]) },
];

test("ranking filters below the threshold and sorts best-first", () => {
  const hits = rankBySimilarity([1, 0, 0], index, { minScore: 0.5 });
  assert.deepEqual(
    hits.map((h) => h.refId),
    ["1", "9"] // exact match first, near match second, orthogonal dropped
  );
  assert.ok(hits[0].score > hits[1].score);
});

test("ranking respects the limit", () => {
  const hits = rankBySimilarity([1, 0.5, 0], index, { minScore: 0, limit: 1 });
  assert.equal(hits.length, 1);
});

test("dedupe drops fuzzy hits the exact tier already found (prefix-tolerant)", () => {
  const hits = [
    { source: "mail", refId: "9", text: "Your itinerary — Delta", score: 0.8 },
    { source: "task", refId: "1", text: "book flight to NYC", score: 0.7 },
  ];
  // Exact tier shows the mail subject without the sender suffix.
  const kept = dedupeAgainstExact(hits, ["your itinerary"]);
  assert.deepEqual(kept.map((h) => h.refId), ["1"]);
  // Note paths: exact shows "foo.md", index stores "foo".
  const notes = [{ source: "note", refId: "foo.md", text: "foo", score: 0.9 }];
  assert.deepEqual(dedupeAgainstExact(notes, ["foo.md"]), []);
});

test("dedupe with no exact hits keeps everything", () => {
  const hits = [{ source: "task", refId: "1", text: "book flight", score: 0.7 }];
  assert.deepEqual(dedupeAgainstExact(hits, []), hits);
});
