/**
 * catalog-resolver.js
 *
 * Resolves a natural-language purchase intent to a specific product row.
 *
 * DESIGN NOTE: This uses simple keyword/fuzzy matching, not an LLM call.
 * For the demo scenarios (coffee subscription, 3-month plan, gift card)
 * this is completely sufficient and keeps resolution deterministic and
 * fast. An LLM can be layered on top later purely to *paraphrase* the
 * buyer's free text into a search query — it should never be the thing
 * that decides which product or price gets used.
 */

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "db", "merchantguard.db");

function getDb() {
  return new Database(DB_PATH, { readonly: true });
}

// Generic words that appear across multiple product names/billing
// language and don't help disambiguate which product was meant.
// Found via testing: "month" alone caused "...for ₹1,299/month" to
// mismatch against the "3 Month" SKU, since both share that word.
const STOPWORDS = new Set([
  "the", "for", "a", "an", "to", "me", "my", "buy", "get", "want",
  "please", "plan", "subscribe", "subscription", "month", "monthly",
]);

/**
 * Scoring function: counts how many *meaningful* (non-stopword) words
 * of the intent appear in the product name or category, plus explicit
 * multi-word phrase boosts for cases plain word-overlap can't resolve
 * (e.g. "3-month" vs "monthly" both containing "month").
 */
function score(intentWords, product) {
  const haystack = `${product.name} ${product.category}`.toLowerCase();
  const intentText = intentWords.join(" ");
  let s = 0;

  for (const w of intentWords) {
    if (w.length < 3) continue;
    if (STOPWORDS.has(w)) continue;
    if (haystack.includes(w)) s += 1;
  }

  // Explicit phrase-level disambiguation — these look at the FULL
  // intent text, not the stopword-filtered word list, since the
  // signal here is specifically about multi-word phrases.
  const isGiftIntent = /gift/i.test(intentText);
  const is3MonthIntent = /3.?month|three.?month|quarterly/i.test(intentText);

  if (isGiftIntent && product.category === "gift_card") s += 2;
  if (is3MonthIntent && product.sku.includes("3month")) s += 3;
  // Explicitly penalize the 3-month SKU when the intent does NOT
  // signal a 3-month plan — otherwise it wins ties on "premium"+"coffee"
  // alone whenever a monthly-plan product is also in the running.
  if (!is3MonthIntent && product.sku.includes("3month")) s -= 1;

  return s;
}

/**
 * resolveIntent(text) -> { matched: boolean, product, candidates, rawIntent }
 */
export function resolveIntent(rawIntent) {
  const db = getDb();
  try {
    const products = db.prepare("SELECT * FROM products WHERE active = 1").all();
    const words = rawIntent.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);

    const scored = products
      .map((p) => ({ product: p, score: score(words, p) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score === 0) {
      return { matched: false, product: null, candidates: scored.slice(0, 3), rawIntent };
    }

    return { matched: true, product: best.product, candidates: scored.slice(0, 3), rawIntent };
  } finally {
    db.close();
  }
}

/**
 * Extract a requested quantity from the intent text. Defaults to 1.
 *
 * IMPORTANT: only treat a number as a quantity if it's followed by an
 * explicit quantity unit (x, units, bags, packs, qty). A bare number
 * is NOT assumed to be quantity, because plan-duration phrases like
 * "3-month plan" or price phrases like "₹1,299/month" also contain
 * numbers that mean something else entirely. This was found by
 * testing "Buy the 3-month Premium plan." against the earlier version
 * of this function, which incorrectly returned quantity=3.
 */
export function extractQuantity(rawIntent) {
  const m = rawIntent.match(/\b(\d+)\s*(x|units?|bags?|packs?|qty)\b/i);
  if (m && Number(m[1]) > 0 && Number(m[1]) < 1000) return Number(m[1]);
  return 1;
}
