import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFinanceFilter,
  escapeLike,
} from "../lib/finance/query-builder.ts";

test("spend metric: negatives only, transfers/investments excluded, sign-flipped sum", () => {
  const f = buildFinanceFilter({ metric: "spend" });
  assert.equal(f.where, "amount < 0 AND category NOT IN ('Transfer','Investment')");
  assert.deepEqual(f.params, []);
  assert.equal(f.sumExpr, "SUM(-amount)");
});

test("income and net metrics", () => {
  assert.match(buildFinanceFilter({ metric: "income" }).where, /amount > 0/);
  assert.equal(buildFinanceFilter({ metric: "net" }).where, "category != 'Transfer'");
});

test("category and month become bound parameters", () => {
  const f = buildFinanceFilter({ metric: "spend", category: "Dining", month: "2026-06" });
  assert.match(f.where, /category = \?/);
  assert.match(f.where, /substr\(date, 1, 7\) = \?/);
  assert.deepEqual(f.params, ["Dining", "2026-06"]);
});

test("date range bounds", () => {
  const f = buildFinanceFilter({
    metric: "net",
    start_date: "2026-01-01",
    end_date: "2026-03-31",
  });
  assert.match(f.where, /date >= \?/);
  assert.match(f.where, /date <= \?/);
  assert.deepEqual(f.params, ["2026-01-01", "2026-03-31"]);
});

test("merchant fragment is uppercased and LIKE-escaped", () => {
  const f = buildFinanceFilter({ metric: "spend", merchant_contains: "50%_off" });
  assert.deepEqual(f.params, ["%50\\%\\_OFF%", "%50\\%\\_OFF%"]);
  assert.match(f.where, /ESCAPE '\\\\'|ESCAPE '\\'/);
});

test("escapeLike covers backslash, percent, underscore", () => {
  assert.equal(escapeLike("a%b_c\\d"), "a\\%b\\_c\\\\d");
});

test("no raw user text is ever concatenated into WHERE", () => {
  const f = buildFinanceFilter({
    metric: "spend",
    merchant_contains: "'; DROP TABLE transactions; --",
    category: "Other",
  });
  assert.ok(!f.where.includes("DROP"), "injection text stays in params");
  assert.ok(f.params.some((p) => String(p).includes("DROP")));
});
