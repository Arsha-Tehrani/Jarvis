// Pure categorization rules (no LLM/DB import) so `node --test` can prove the
// keyword logic directly and the UI can introspect it. lib/finance/categorize.ts
// wraps these with the LLM-first orchestration.

export const CATEGORIES = [
  "Income",
  "Rent",
  "Bills & Utilities",
  "Subscriptions",
  "Groceries",
  "Dining",
  "Transport",
  "Shopping",
  "Entertainment",
  "Health",
  "Travel",
  "Investment",
  "Transfer",
  "Fees",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

// Outgoing transfers to a brokerage/investment account. Keyed on description
// text ONLY (never amount — a weekly contribution grows over time, so any
// amount-based logic would miss it). Bank wording varies wildly, so this is
// kept as one extendable list: "Fid Bkg Svc … Moneyline" is the real Fidelity
// ACH descriptor that an "FIDELITY" keyword alone never catches. Add new
// variants here as statements surface them.
export const INVESTMENT_TRANSFER =
  /FID(ELITY)?\s*B(KG|ROKERAGE)|FID BKG SVC|MONEYLINE|NETX\s?INVEST|NETXINVEST|\bNETX\b|VANGUARD|SCHWAB|ROBINHOOD|E-?TRADE|WEALTHFRONT|BETTERMENT|COINBASE|WEBULL|\bBROKERAGE\b/i;

export const RULES: Array<[RegExp, Category]> = [
  [/PAYROLL|DIRECT DEP|SALARY|PAYCHECK/i, "Income"],
  [/RENT|LANDLORD|APARTMENT|PROPERTY MGMT/i, "Rent"],
  [/NETFLIX|SPOTIFY|HULU|DISNEY\+|YOUTUBE PREM|APPLE\.COM\/BILL|ICLOUD|PRIME VIDEO|HBO|CRUNCHYROLL|AUDIBLE|PATREON|SUBSTACK|NYTIMES|CHATGPT|OPENAI|CLAUDE/i, "Subscriptions"],
  [/ELECTRIC|POWER|WATER|SEWER|GAS CO|INTERNET|COMCAST|XFINITY|VERIZON|T-?MOBILE|AT&T|UTILITY|HYDRO/i, "Bills & Utilities"],
  [/WHOLE FOODS|TRADER JOE|KROGER|SAFEWAY|ALDI|COSTCO|SPROUTS|WEGMANS|H-E-B|PUBLIX|GROCERY|SUPERMARKET|FOOD LION/i, "Groceries"],
  [/MCDONALD|STARBUCKS|CHIPOTLE|SUBWAY|WENDY|TACO BELL|KFC|DOMINO|PIZZA|DOORDASH|UBER\s?EATS|GRUBHUB|RESTAURANT|CAFE|COFFEE|BAKERY|DINER|SUSHI|THAI|BURGER/i, "Dining"],
  [/UBER(?!\s?EATS)|LYFT|SHELL|CHEVRON|EXXON|MOBIL|BP\b|GAS STATION|PARKING|TRANSIT|METRO|AMTRAK|TOLL|FUEL/i, "Transport"],
  [/AMAZON|TARGET|WALMART|BEST BUY|EBAY|ETSY|IKEA|HOME DEPOT|LOWE'?S|NIKE|ZARA|H&M|SEPHORA/i, "Shopping"],
  [/CINEMA|AMC|REGAL|TICKETMASTER|STEAM|PLAYSTATION|XBOX|NINTENDO|CONCERT|SPOTIFY LIVE|EVENTBRITE/i, "Entertainment"],
  [/CVS|WALGREENS|PHARMACY|DENTAL|MEDICAL|CLINIC|HOSPITAL|DOCTOR|OPTOMETR|THERAP|GYM|FITNESS|PLANET FIT|EQUINOX|CRUNCH/i, "Health"],
  [/AIRLINE|DELTA|UNITED|AMERICAN AIR|SOUTHWEST|JETBLUE|HOTEL|MARRIOTT|HILTON|AIRBNB|EXPEDIA|BOOKING\.COM|HERTZ|AVIS/i, "Travel"],
  [INVESTMENT_TRANSFER, "Investment"],
  // Credit-card payoffs / autopay: a transfer between the user's own
  // accounts, not income — keep them out of the income and spend totals.
  [/PAYMENT THANK YOU|AUTOPAY|ONLINE PMT|E-?PAYMENT|PAYMENT TO .*(CARD|CHASE|AMEX|CAPITAL ONE|DISCOVER|CITI)/i, "Transfer"],
  [/ZELLE|VENMO|PAYPAL|CASH APP|WIRE|TRANSFER|WITHDRAWAL|ATM/i, "Transfer"],
  [/FEE|INTEREST CHARGE|OVERDRAFT|SERVICE CHARGE/i, "Fees"],
];

// Deterministic, authoritative categories that OVERRIDE the LLM. The model
// mislabels "Fid Bkg Svc Moneyline" as a generic Transfer; a brokerage ACH is
// unambiguously an investment contribution, so we force it regardless of what
// the model said. Returns null when no forced rule applies (LLM/keywords win).
export function forcedCategory(description: string): Category | null {
  if (INVESTMENT_TRANSFER.test(description)) return "Investment";
  return null;
}

export function categorizeByRules(description: string, amount: number): Category {
  for (const [re, category] of RULES) {
    if (re.test(description)) return category;
  }
  if (amount > 0) return "Income";
  return "Other";
}

// The specific keyword that a description matched, for the "why is this in
// category X?" explainer. Returns the first matching rule's category and the
// exact substring that matched (so the UI can show "matched 'MONEYLINE'").
export function matchedRule(description: string): { category: Category; keyword: string } | null {
  for (const [re, category] of RULES) {
    const m = re.exec(description);
    if (m) return { category, keyword: m[0] };
  }
  return null;
}

// Explain how a transaction ended up in its category, derived from the REAL
// rules (never a hand-written copy that can drift). A forced/keyword match is
// reported with the matched keyword; anything else was the model's call.
export type CategoryExplanation =
  | { source: "keyword"; keyword: string }
  | { source: "model" };

export function explainCategory(description: string, category: string): CategoryExplanation {
  if (forcedCategory(description) === category) {
    const m = INVESTMENT_TRANSFER.exec(description);
    return { source: "keyword", keyword: m ? m[0] : "brokerage transfer" };
  }
  const rule = matchedRule(description);
  if (rule && rule.category === category) return { source: "keyword", keyword: rule.keyword };
  return { source: "model" };
}

// One representative keyword list per category, generated FROM the rules above,
// for the in-app category reference. Categories with no keyword rule (Other) get
// an empty list and a caption elsewhere.
export function categoryReference(): Array<{ category: Category; keywords: string[] }> {
  // Pull literal alternatives out of each rule's source, skipping regex noise.
  const byCategory = new Map<Category, string[]>();
  for (const [re, category] of RULES) {
    const literals = re.source
      .split("|")
      .map((s) => s.replace(/[\\()?:.^$*+\[\]{}]/g, "").replace(/\bi\b/g, "").trim())
      .filter((s) => s.length >= 2 && /[A-Za-z]/.test(s));
    const prev = byCategory.get(category) ?? [];
    byCategory.set(category, [...prev, ...literals]);
  }
  return CATEGORIES.map((category) => ({
    category,
    keywords: [...new Set(byCategory.get(category) ?? [])].slice(0, 12),
  }));
}
