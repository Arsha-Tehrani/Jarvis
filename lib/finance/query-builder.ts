// Vetted query builder for the query_finance tool — pure and unit-tested.
// The model NEVER emits SQL: it fills a zod-validated args object, and this
// maps those args onto a fixed WHERE template with bound parameters only.

export type FinanceQueryArgs = {
  metric: "spend" | "income" | "net";
  category?: string;
  merchant_contains?: string;
  month?: string; // YYYY-MM
  start_date?: string; // YYYY-MM-DD
  end_date?: string; // YYYY-MM-DD
};

export type FinanceFilter = {
  where: string;
  params: (string | number)[];
  // Sign convention the caller must apply when summing:
  // spend sums -amount over negatives; income sums amount over positives;
  // net sums amount over everything non-transfer.
  sumExpr: string;
};

// Escape LIKE wildcards in user-derived fragments; query uses ESCAPE '\'.
export function escapeLike(fragment: string): string {
  return fragment.replace(/([\\%_])/g, "\\$1");
}

export function buildFinanceFilter(args: FinanceQueryArgs): FinanceFilter {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  let sumExpr: string;
  switch (args.metric) {
    case "spend":
      clauses.push("amount < 0", "category NOT IN ('Transfer','Investment')");
      sumExpr = "SUM(-amount)";
      break;
    case "income":
      clauses.push("amount > 0", "category != 'Transfer'");
      sumExpr = "SUM(amount)";
      break;
    case "net":
      clauses.push("category != 'Transfer'");
      sumExpr = "SUM(amount)";
      break;
  }

  if (args.category) {
    clauses.push("category = ?");
    params.push(args.category);
  }
  if (args.merchant_contains) {
    clauses.push(
      "(merchant LIKE ? ESCAPE '\\' OR raw_description LIKE ? ESCAPE '\\')"
    );
    const like = `%${escapeLike(args.merchant_contains.toUpperCase())}%`;
    params.push(like, like);
  }
  if (args.month) {
    clauses.push("substr(date, 1, 7) = ?");
    params.push(args.month);
  }
  if (args.start_date) {
    clauses.push("date >= ?");
    params.push(args.start_date);
  }
  if (args.end_date) {
    clauses.push("date <= ?");
    params.push(args.end_date);
  }

  return { where: clauses.join(" AND "), params, sumExpr };
}
