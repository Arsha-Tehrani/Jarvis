import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  looksLikeBrokerageTable,
  parseBrokerageTable,
  parseFidelityPdfHoldings,
} from "../lib/finance/brokerage-parse.ts";
import { parseCsv } from "../lib/finance/parse.ts";

// Real Fidelity statement holding rows as pdfjs extracts them:
//   <NAME> (<SYMBOL>) <begin> <qty> <price> <mktval> <cost> <unrealized> <eai|->
const FIDELITY_HOLDINGS = `
Symbol/
CUSIP Description Quantity Price Market Value Cost Basis Unrealized
MICROSOFT CORP (MSFT) 450.24 2.000 373.0200 746.04 770.47 -24.43 7.28
ALPHABET INC CAP STK CL A(GOOGL) 760.68 2.000 357.3700 714.74 694.80 19.94 1.76
TESLA INC COM (TSLA) 217.89 0.500 420.6000 210.30 133.81 76.49 -
NIKE INC CLASS B COM NPV(NKE) 323.61 7.000 41.0500 287.35 456.40 -169.05 11.48
(May not reflect all gains and losses due to incomplete cost basis)
Total Cost Basis does not include the cost basis on core positions.
`;

test("parseFidelityPdfHoldings: extracts ticker/shares/cost-basis from statement rows", () => {
  const holdings = parseFidelityPdfHoldings(FIDELITY_HOLDINGS);
  const by = Object.fromEntries(holdings.map((h) => [h.ticker, h]));

  assert.equal(holdings.length, 4);
  // qty from the quantity column (not the leading "begin value" column).
  assert.equal(by.MSFT.shares, 2);
  assert.equal(by.TSLA.shares, 0.5);
  assert.equal(by.NKE.shares, 7);
  // cost basis per share = total cost / shares.
  assert.equal(by.MSFT.cost_basis, 385.24); // 770.47 / 2
  assert.equal(by.GOOGL.cost_basis, 347.4); // 694.80 / 2
  assert.equal(by.NKE.cost_basis, 65.2); // 456.40 / 7
});

test("parseFidelityPdfHoldings: disclaimer/prose lines are not mistaken for holdings", () => {
  // No line here satisfies qty*price == market value.
  const noise = `
(May not reflect all gains and losses due to incomplete cost basis)
Your Account Value: $19,214.47
Beginning Account Value $19,091.87 $16,206.74
`;
  assert.deepEqual(parseFidelityPdfHoldings(noise), []);
});

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
