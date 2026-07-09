import assert from "node:assert/strict";
import { test } from "node:test";
import { findTransferPairs, type TransferCandidate } from "../lib/finance/transfers.ts";

// A credit-card payment is one real dollar movement that shows up as two
// transaction rows: an outflow on checking, an inflow on the card. Without
// pairing them, both count as real spend/income — this is the exact
// double-counting bug the fix addresses.

test("matches a checking outflow to its credit-card payment inflow", () => {
  const rows: TransferCandidate[] = [
    { id: 1, date: "2026-06-15", amount: -500, raw_description: "ONLINE PAYMENT TO CHASE CARD 1234", statement_id: 1 },
    { id: 2, date: "2026-06-16", amount: 500, raw_description: "PAYMENT - THANK YOU", statement_id: 2 },
  ];
  assert.deepEqual(new Set(findTransferPairs(rows)), new Set([1, 2]));
});

test("does not match the same amount 40 days apart", () => {
  const rows: TransferCandidate[] = [
    { id: 1, date: "2026-05-01", amount: -500, raw_description: "ONLINE PAYMENT TO CHASE CARD", statement_id: 1 },
    { id: 2, date: "2026-06-10", amount: 500, raw_description: "PAYMENT - THANK YOU", statement_id: 2 },
  ];
  assert.deepEqual(findTransferPairs(rows), []);
});

test("does not match rows from the same statement (not cross-account)", () => {
  const rows: TransferCandidate[] = [
    { id: 1, date: "2026-06-15", amount: -500, raw_description: "PAYMENT TO CARD", statement_id: 1 },
    { id: 2, date: "2026-06-15", amount: 500, raw_description: "PAYMENT - THANK YOU", statement_id: 1 },
  ];
  assert.deepEqual(findTransferPairs(rows), []);
});

test("does not match equal-and-opposite amounts with no payment/transfer wording", () => {
  const rows: TransferCandidate[] = [
    { id: 1, date: "2026-06-15", amount: -20, raw_description: "STARBUCKS COFFEE", statement_id: 1 },
    { id: 2, date: "2026-06-16", amount: 20, raw_description: "TARGET STORE", statement_id: 2 },
  ];
  assert.deepEqual(findTransferPairs(rows), []);
});

test("does not match same-sign amounts (both outflows)", () => {
  const rows: TransferCandidate[] = [
    { id: 1, date: "2026-06-15", amount: -500, raw_description: "AUTOPAY PAYMENT", statement_id: 1 },
    { id: 2, date: "2026-06-16", amount: -500, raw_description: "AUTOPAY PAYMENT", statement_id: 2 },
  ];
  assert.deepEqual(findTransferPairs(rows), []);
});

test("ignores zero-amount rows", () => {
  const rows: TransferCandidate[] = [
    { id: 1, date: "2026-06-15", amount: 0, raw_description: "PAYMENT ADJUSTMENT", statement_id: 1 },
    { id: 2, date: "2026-06-16", amount: 0, raw_description: "PAYMENT ADJUSTMENT", statement_id: 2 },
  ];
  assert.deepEqual(findTransferPairs(rows), []);
});

test("picks the correct pair among multiple same-amount candidates", () => {
  const rows: TransferCandidate[] = [
    { id: 1, date: "2026-06-15", amount: -500, raw_description: "ONLINE PAYMENT TO CARD", statement_id: 1 },
    { id: 2, date: "2026-01-01", amount: 500, raw_description: "PAYMENT - THANK YOU", statement_id: 2 }, // too far — decoy
    { id: 3, date: "2026-06-16", amount: 500, raw_description: "PAYMENT - THANK YOU", statement_id: 3 }, // real match
  ];
  const matched = findTransferPairs(rows);
  assert.deepEqual(new Set(matched), new Set([1, 3]));
});
