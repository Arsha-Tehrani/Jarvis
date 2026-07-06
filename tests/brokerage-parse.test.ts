import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  looksLikeBrokerageTable,
  parseBrokerageTable,
} from "../lib/finance/brokerage-parse.ts";
import { parseCsv } from "../lib/finance/parse.ts";

const sampleTable = parseCsv(
  fs.readFileSync(
    path.join(process.cwd(), "samples", "fidelity-positions-synthetic.csv"),
    "utf8"
  )
);

test("fidelity positions sample: sniffed as brokerage, parsed to holdings", () => {
  assert.equal(looksLikeBrokerageTable(sampleTable), true);
  const { holdings, source } = parseBrokerageTable(sampleTable);
  assert.equal(source, "positions");
  assert.deepEqual(holdings, [
    { ticker: "VOO", shares: 10, cost_basis: 420.5 },
    { ticker: "AAPL", shares: 15.5, cost_basis: 177.42 },
    { ticker: "SPAXX", shares: 231.47, cost_basis: 1 }, // ** suffix stripped
  ]);
  // "Pending Activity" pseudo-row skipped; account column never surfaces.
  assert.ok(!JSON.stringify(holdings).includes("X12345678"));
});

test("bank statement is NOT sniffed as brokerage", () => {
  const bank = parseCsv("Date,Description,Amount\n2026-06-01,COFFEE,-4.50\n");
  assert.equal(looksLikeBrokerageTable(bank), false);
});

test("history export reconstructs net positions with buy-weighted cost", () => {
  const history = parseCsv(
    [
      "Run Date,Action,Symbol,Description,Type,Quantity,Price ($),Amount ($)",
      "05/01/2026, YOU BOUGHT ,AAPL,APPLE INC,Cash,10,200.00,-2000.00",
      "05/15/2026, YOU BOUGHT ,AAPL,APPLE INC,Cash,10,220.00,-2200.00",
      "06/01/2026, YOU SOLD ,AAPL,APPLE INC,Cash,-5,230.00,1150.00",
      "06/02/2026, YOU SOLD ,TSLA,TESLA INC,Cash,-3,180.00,540.00",
      "06/02/2026, YOU BOUGHT ,TSLA,TESLA INC,Cash,3,170.00,-510.00",
      "06/10/2026,DIVIDEND RECEIVED,VOO,VANGUARD,Cash,,,12.34",
    ].join("\n")
  );
  const { holdings, source } = parseBrokerageTable(history);
  assert.equal(source, "history");
  // AAPL: 10+10-5 = 15 shares, avg buy (200*10+220*10)/20 = 210
  assert.deepEqual(holdings, [{ ticker: "AAPL", shares: 15, cost_basis: 210 }]);
});

test("unrecognized layout throws the export-as-CSV guidance", () => {
  assert.throws(
    () => parseBrokerageTable(parseCsv("Foo,Bar\n1,2\n")),
    /Symbol column/
  );
});
