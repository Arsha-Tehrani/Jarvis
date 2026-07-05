import { z } from "zod";
import { chat } from "@/lib/llm";

// Categorization: LLM first (only merchant/amount lines — never full
// statements), keyword rules as the always-working fallback so ingest
// succeeds even with no model running.

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

type Line = { id: number; description: string; amount: number };

export type CategorizeOutcome = {
  categories: Map<number, Category>;
  source: "llm" | "rules" | "llm+rules";
  llmError?: string;
};

const BATCH_SIZE = 40;

const llmResponseSchema = z.array(
  z.object({ id: z.number().int(), category: z.enum(CATEGORIES) })
);

export async function categorizeTransactions(lines: Line[]): Promise<CategorizeOutcome> {
  const categories = new Map<number, Category>();
  let llmError: string | undefined;
  let usedLlm = false;

  for (let i = 0; i < lines.length; i += BATCH_SIZE) {
    const batch = lines.slice(i, i + BATCH_SIZE);
    if (!llmError) {
      try {
        const result = await categorizeBatchLlm(batch);
        for (const [id, cat] of result) categories.set(id, cat);
        usedLlm = true;
        continue;
      } catch (err) {
        llmError = err instanceof Error ? err.message : "LLM categorization failed";
        console.error("[finance] LLM categorization failed, falling back to rules:", llmError);
      }
    }
    for (const line of batch) {
      categories.set(line.id, categorizeByRules(line.description, line.amount));
    }
  }

  // Any ids the LLM skipped get rule-based categories.
  let filledByRules = false;
  for (const line of lines) {
    if (!categories.has(line.id)) {
      categories.set(line.id, categorizeByRules(line.description, line.amount));
      filledByRules = true;
    }
  }

  const source = usedLlm ? (llmError || filledByRules ? "llm+rules" : "llm") : "rules";
  return { categories, source, llmError };
}

async function categorizeBatchLlm(batch: Line[]): Promise<Map<number, Category>> {
  const listing = batch
    .map((l) => `${l.id}\t${l.description}\t${l.amount.toFixed(2)}`)
    .join("\n");
  const result = await chat({
    messages: [
      {
        role: "system",
        content: [
          "You categorize bank transactions.",
          `Allowed categories: ${CATEGORIES.join(", ")}.`,
          "Input lines are: id<TAB>description<TAB>amount (negative = money out).",
          'Respond with ONLY a JSON array like [{"id":1,"category":"Groceries"}] covering every id. No prose.',
        ].join(" "),
      },
      { role: "user", content: listing },
    ],
  });
  const text = result.text ?? "";
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("LLM response contained no JSON array");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error("LLM response was not valid JSON");
  }
  const validated = llmResponseSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`LLM response failed validation: ${z.prettifyError(validated.error)}`);
  }
  const map = new Map<number, Category>();
  const validIds = new Set(batch.map((l) => l.id));
  for (const row of validated.data) {
    if (validIds.has(row.id)) map.set(row.id, row.category);
  }
  return map;
}

const RULES: Array<[RegExp, Category]> = [
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
  [/VANGUARD|FIDELITY|SCHWAB|ROBINHOOD|ETRADE|WEALTHFRONT|BETTERMENT|COINBASE|BROKERAGE/i, "Investment"],
  [/ZELLE|VENMO|PAYPAL|CASH APP|WIRE|TRANSFER|WITHDRAWAL|ATM/i, "Transfer"],
  [/FEE|INTEREST CHARGE|OVERDRAFT|SERVICE CHARGE/i, "Fees"],
];

export function categorizeByRules(description: string, amount: number): Category {
  for (const [re, category] of RULES) {
    if (re.test(description)) return category;
  }
  if (amount > 0) return "Income";
  return "Other";
}
