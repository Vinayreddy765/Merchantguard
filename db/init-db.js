/**
 * init-db.js
 *
 * Creates the SQLite schema and seeds:
 *   - BrewCycle's product catalog (from catalog/seed-products.json)
 *   - one merchant policy record (the rules MerchantGuard enforces)
 *
 * All money amounts are stored in PAISE (smallest INR unit), matching
 * Razorpay's own API convention (create_payment_link amount = paise).
 * The policy thresholds below are written in rupees in comments for
 * readability, but stored as paise in the DB.
 *
 * Usage: node db/init-db.js
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "merchantguard.db");
const SEED_PATH = path.join(__dirname, "..", "catalog", "seed-products.json");

// Start fresh each time this is run — fine for a hackathon build.
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price_paise INTEGER NOT NULL,
  billing_interval TEXT,
  min_commitment_months INTEGER DEFAULT 0,
  max_qty_per_order INTEGER DEFAULT 1,
  active INTEGER DEFAULT 1
);

CREATE TABLE policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT NOT NULL,
  max_auto_amount_paise INTEGER NOT NULL,
  max_human_amount_paise INTEGER NOT NULL,
  allowed_categories TEXT NOT NULL,        -- JSON array
  max_quantity INTEGER NOT NULL,
  subscription_requires_confirmation INTEGER DEFAULT 1,
  velocity_limit_per_day INTEGER NOT NULL
);

CREATE TABLE agent_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  status TEXT NOT NULL,                    -- pending | approved | rejected | executed
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  actor TEXT NOT NULL,                     -- 'buyer_agent' | 'merchantguard' | 'merchant_human'
  action TEXT NOT NULL,
  input TEXT,                              -- JSON
  decision TEXT,                           -- AUTO_APPROVE | HUMAN_APPROVAL | REJECT | EXECUTED
  reason TEXT,
  checks TEXT,                             -- JSON array of individual policy checks (structured, not prose)
  amount_paise INTEGER,
  mcp_tool TEXT,
  result TEXT,                             -- JSON, the MCP tool result if one was called
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
);
`);

// --- Seed products ---
const products = JSON.parse(fs.readFileSync(SEED_PATH, "utf-8"));
const insertProduct = db.prepare(`
  INSERT INTO products (sku, name, category, price_paise, billing_interval, min_commitment_months, max_qty_per_order, active)
  VALUES (@sku, @name, @category, @price_paise, @billing_interval, @min_commitment_months, @max_qty_per_order, @active)
`);
const insertMany = db.transaction((rows) => {
  for (const r of rows) insertProduct.run({ ...r, active: r.active ? 1 : 0 });
});
insertMany(products);

// --- Seed the merchant policy ---
// AUTO_APPROVE   <= ₹2,000   (200000 paise)
// HUMAN_APPROVAL  ₹2,001–₹5,000  (200001–500000 paise)
// REJECT          > ₹5,000  (>500000 paise)
// Allowed categories: coffee_subscription, coffee_onetime
// Restricted: gift_card (explicitly NOT in allowed_categories)
// Velocity: 1 subscription action per buyer per day
db.prepare(`
  INSERT INTO policies (merchant_id, max_auto_amount_paise, max_human_amount_paise, allowed_categories, max_quantity, subscription_requires_confirmation, velocity_limit_per_day)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
  "brewcycle",
  200000,
  500000,
  JSON.stringify(["coffee_subscription", "coffee_onetime"]),
  5,
  1,
  1
);

console.log(`✅ Database initialized at ${DB_PATH}`);
console.log(`   ${products.length} products seeded`);
console.log(`   1 policy seeded for merchant "brewcycle"`);

db.close();
