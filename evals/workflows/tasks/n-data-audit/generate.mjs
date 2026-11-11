// Generates n-data-audit's fixed input (20 CSV tables and their schema) with planted defects, and the hidden
// rubric listing every planted defect. Deterministic: rerunning it rewrites the same bytes. Regenerate only to
// change the task, and bump the task's version when you do.
//
//   node evals/workflows/tasks/n-data-audit/generate.mjs
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const input = join(here, "input"), hidden = join(here, "hidden");
rmSync(input, { recursive: true, force: true });
mkdirSync(join(input, "tables"), { recursive: true });
mkdirSync(hidden, { recursive: true });

let seed = 7741;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (list) => list[Math.floor(rand() * list.length)];
const day = (offset) => new Date(Date.UTC(2025, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);
const SNAPSHOT = "2026-10-31";
const CURRENCIES = ["USD", "EUR", "GBP"];
const FIRST = ["Ada", "Ben", "Cleo", "Dev", "Eli", "Fay", "Gus", "Hana", "Ivo", "Jun", "Kai", "Lea", "Max", "Noor", "Otis", "Pia"];
const LAST = ["Abe", "Brook", "Chen", "Diaz", "Etto", "Faro", "Gill", "Holt", "Ito", "Jain", "Kerr", "Lund"];
const WORDS = ["checked", "late", "fragile", "priority", "reorder", "follow up", "approved", "pending review", "gift", "bulk"];
const note = () => (rand() < 0.4 ? "" : `${pick(WORDS)}; ${pick(WORDS)}`);

/** Every table: its columns (name, type, required, rule) and how to make a row. */
const tables = {};
const define = (name, description, columns, count, make) => { tables[name] = { name, description, columns, rows: Array.from({ length: count }, (_, index) => make(index + 1)) }; };
const col = (name, type, extra = {}) => ({ name, type, required: true, ...extra });

define("customers", "People and companies that buy from us.", [col("customer_id", "integer", { key: true }), col("name", "text"), col("email", "email"), col("country", "text"), col("notes", "text", { required: false, freeText: true })], 120,
  (id) => ({ customer_id: id, name: `${pick(FIRST)} ${pick(LAST)}`, email: `c${id}@example.com`, country: pick(["US", "DE", "GB", "FR", "ES"]), notes: note() }));
define("suppliers", "Companies we buy stock from.", [col("supplier_id", "integer", { key: true }), col("name", "text"), col("contact_email", "email"), col("currency", "currency")], 30,
  (id) => ({ supplier_id: id, name: `${pick(LAST)} Supply ${id}`, contact_email: `s${id}@supplier.example`, currency: pick(CURRENCIES) }));
define("products", "What we sell.", [col("product_id", "integer", { key: true }), col("supplier_id", "integer", { references: "suppliers.supplier_id" }), col("name", "text"), col("unit_price", "money", { min: 0 }), col("currency", "currency")], 80,
  (id) => ({ product_id: id, supplier_id: int(1, 30), name: `Part ${id}`, unit_price: (int(100, 50000) / 100).toFixed(2), currency: pick(CURRENCIES) }));
define("warehouses", "Where stock is kept.", [col("warehouse_id", "integer", { key: true }), col("city", "text"), col("opened_on", "date", { notAfterSnapshot: true })], 12,
  (id) => ({ warehouse_id: id, city: pick(["Austin", "Berlin", "Leeds", "Lyon", "Porto", "Reno"]), opened_on: day(-int(400, 3000)) }));
define("inventory", "Stock on hand per product and warehouse.", [col("inventory_id", "integer", { key: true }), col("product_id", "integer", { references: "products.product_id" }), col("warehouse_id", "integer", { references: "warehouses.warehouse_id" }), col("quantity", "integer", { min: 0 }), col("counted_on", "date", { notAfterSnapshot: true })], 150,
  (id) => ({ inventory_id: id, product_id: int(1, 80), warehouse_id: int(1, 12), quantity: int(0, 900), counted_on: day(int(0, 660)) }));
define("orders", "Customer orders.", [col("order_id", "integer", { key: true }), col("customer_id", "integer", { references: "customers.customer_id" }), col("ordered_on", "date", { notAfterSnapshot: true }), col("currency", "currency"), col("notes", "text", { required: false, freeText: true })], 200,
  (id) => ({ order_id: id, customer_id: int(1, 120), ordered_on: day(int(0, 660)), currency: pick(CURRENCIES), notes: note() }));
define("order_items", "Lines of an order.", [col("order_item_id", "integer", { key: true }), col("order_id", "integer", { references: "orders.order_id" }), col("product_id", "integer", { references: "products.product_id" }), col("quantity", "integer", { min: 1 }), col("line_total", "money", { min: 0 })], 300,
  (id) => ({ order_item_id: id, order_id: int(1, 200), product_id: int(1, 80), quantity: int(1, 12), line_total: (int(100, 90000) / 100).toFixed(2) }));
define("invoices", "What we billed.", [col("invoice_id", "integer", { key: true }), col("order_id", "integer", { references: "orders.order_id" }), col("issued_on", "date", { notAfterSnapshot: true }), col("amount", "money", { min: 0 }), col("currency", "currency")], 180,
  (id) => ({ invoice_id: id, order_id: int(1, 200), issued_on: day(int(0, 660)), amount: (int(500, 200000) / 100).toFixed(2), currency: pick(CURRENCIES) }));
define("payments", "Money received against invoices.", [col("payment_id", "integer", { key: true }), col("invoice_id", "integer", { references: "invoices.invoice_id" }), col("paid_on", "date", { notAfterSnapshot: true }), col("amount", "money", { min: 0 }), col("method", "text")], 170,
  (id) => ({ payment_id: id, invoice_id: int(1, 180), paid_on: day(int(0, 660)), amount: (int(500, 200000) / 100).toFixed(2), method: pick(["card", "wire", "ach"]) }));
define("refunds", "Money returned.", [col("refund_id", "integer", { key: true }), col("payment_id", "integer", { references: "payments.payment_id" }), col("amount", "money", { min: 0 }), col("reason", "text", { required: false, freeText: true })], 40,
  (id) => ({ refund_id: id, payment_id: int(1, 170), amount: (int(100, 20000) / 100).toFixed(2), reason: pick(["damaged", "late", "duplicate charge", "changed mind", ""]) }));
define("shipments", "Parcels sent for orders.", [col("shipment_id", "integer", { key: true }), col("order_id", "integer", { references: "orders.order_id" }), col("warehouse_id", "integer", { references: "warehouses.warehouse_id" }), col("shipped_on", "date", { notAfterSnapshot: true }), col("carrier", "text")], 160,
  (id) => ({ shipment_id: id, order_id: int(1, 200), warehouse_id: int(1, 12), shipped_on: day(int(0, 660)), carrier: pick(["UPS", "DHL", "FedEx", "Royal Mail"]) }));
define("departments", "Teams.", [col("department_id", "integer", { key: true }), col("name", "text")], 8,
  (id) => ({ department_id: id, name: ["Sales", "Support", "Ops", "Finance", "Eng", "Legal", "HR", "Marketing"][id - 1] }));
define("employees", "Staff.", [col("employee_id", "integer", { key: true }), col("department_id", "integer", { references: "departments.department_id" }), col("name", "text"), col("work_email", "email"), col("hired_on", "date", { notAfterSnapshot: true })], 60,
  (id) => ({ employee_id: id, department_id: int(1, 8), name: `${pick(FIRST)} ${pick(LAST)}`, work_email: `e${id}@shop.example`, hired_on: day(-int(0, 2000)) }));
define("tickets", "Support tickets.", [col("ticket_id", "integer", { key: true }), col("customer_id", "integer", { references: "customers.customer_id" }), col("assignee_id", "integer", { references: "employees.employee_id" }), col("opened_on", "date", { notAfterSnapshot: true }), col("summary", "text", { freeText: true })], 140,
  (id) => ({ ticket_id: id, customer_id: int(1, 120), assignee_id: int(1, 60), opened_on: day(int(0, 660)), summary: `${pick(["Order", "Invoice", "Parcel", "Refund"])} ${pick(["missing", "wrong", "late", "question"])}` }));
define("ticket_events", "What happened on a ticket.", [col("event_id", "integer", { key: true }), col("ticket_id", "integer", { references: "tickets.ticket_id" }), col("at", "date", { notAfterSnapshot: true }), col("kind", "text")], 250,
  (id) => ({ event_id: id, ticket_id: int(1, 140), at: day(int(0, 660)), kind: pick(["opened", "reply", "closed", "reopened"]) }));
define("plans", "Subscription plans.", [col("plan_id", "integer", { key: true }), col("name", "text"), col("monthly_price", "money", { min: 0 }), col("currency", "currency")], 6,
  (id) => ({ plan_id: id, name: ["Free", "Starter", "Pro", "Team", "Business", "Enterprise"][id - 1], monthly_price: [0, 9, 29, 49, 99, 499][id - 1].toFixed(2), currency: "USD" }));
define("subscriptions", "Customers on plans.", [col("subscription_id", "integer", { key: true }), col("customer_id", "integer", { references: "customers.customer_id" }), col("plan_id", "integer", { references: "plans.plan_id" }), col("started_on", "date", { notAfterSnapshot: true })], 90,
  (id) => ({ subscription_id: id, customer_id: int(1, 120), plan_id: int(1, 6), started_on: day(int(0, 660)) }));
define("coupons", "Discount codes.", [col("coupon_id", "integer", { key: true }), col("code", "text"), col("percent_off", "integer", { min: 0, max: 100 })], 25,
  (id) => ({ coupon_id: id, code: `SAVE${id}${pick(["A", "B", "C"])}`, percent_off: int(5, 50) }));
define("reviews", "Product reviews.", [col("review_id", "integer", { key: true }), col("product_id", "integer", { references: "products.product_id" }), col("customer_id", "integer", { references: "customers.customer_id" }), col("stars", "integer", { min: 1, max: 5 }), col("body", "text", { required: false, freeText: true })], 130,
  (id) => ({ review_id: id, product_id: int(1, 80), customer_id: int(1, 120), stars: int(1, 5), body: pick(["Great", "Works fine", "Broke after a week", "As described", ""]) }));
define("addresses", "Shipping addresses.", [col("address_id", "integer", { key: true }), col("customer_id", "integer", { references: "customers.customer_id" }), col("line1", "text"), col("city", "text"), col("postcode", "text")], 110,
  (id) => ({ address_id: id, customer_id: int(1, 120), line1: `${int(1, 300)} ${pick(["High St", "Main St", "Elm Rd", "Park Ave"])}`, city: pick(["Austin", "Berlin", "Leeds", "Lyon"]), postcode: String(int(10000, 99999)) }));

// Planted defects: kind, table, column, rows. Several tables stay clean.
const defects = [];
const plant = (table, column, kind, rowIds, apply) => {
  for (const id of rowIds) apply(tables[table].rows[id - 1]);
  defects.push({ table, column, kind, rows: rowIds });
};
plant("customers", "email", "missing_required", [17, 64], (row) => { row.email = ""; });
plant("customers", "notes", "pii_in_free_text", [33], (row) => { row.notes = "call back at dana.ruiz@gmail.com"; });
const duplicate = (table, column, ofRow, copies) => {
  const rows = tables[table].rows, added = [];
  for (let copy = 0; copy < copies; copy++) { rows.push({ ...rows[ofRow - 1] }); added.push(rows.length); }
  defects.push({ table, column, kind: "duplicate_key", rows: [ofRow, ...added] });
};
duplicate("customers", "customer_id", 87, 1);
plant("suppliers", "currency", "invalid_currency", [12], (row) => { row.currency = "US$"; });
plant("products", "unit_price", "negative_amount", [41], (row) => { row.unit_price = "-12.50"; });
plant("products", "supplier_id", "orphan_foreign_key", [9, 70], (row) => { row.supplier_id = 31; });
plant("warehouses", "opened_on", "future_date", [5], (row) => { row.opened_on = "2027-03-01"; });
plant("inventory", "quantity", "negative_amount", [22, 119], (row) => { row.quantity = -4; });
plant("inventory", "warehouse_id", "orphan_foreign_key", [140], (row) => { row.warehouse_id = 13; });
plant("orders", "ordered_on", "future_date", [150], (row) => { row.ordered_on = "2026-12-24"; });
plant("orders", "notes", "pii_in_free_text", [12, 180], (row) => { row.notes = "leave with neighbour, phone +44 7700 900123"; });
plant("orders", "currency", "invalid_currency", [77], (row) => { row.currency = "eur"; });
plant("order_items", "order_id", "orphan_foreign_key", [205], (row) => { row.order_id = 201; });
plant("order_items", "quantity", "negative_amount", [16], (row) => { row.quantity = 0; });
duplicate("invoices", "invoice_id", 100, 2);
plant("invoices", "amount", "missing_required", [55], (row) => { row.amount = ""; });
plant("payments", "invoice_id", "orphan_foreign_key", [9], (row) => { row.invoice_id = 999; });
plant("payments", "paid_on", "future_date", [130], (row) => { row.paid_on = "2026-11-15"; });
plant("refunds", "amount", "negative_amount", [8], (row) => { row.amount = "-30.00"; });
plant("employees", "work_email", "missing_required", [44], (row) => { row.work_email = ""; });
plant("tickets", "summary", "pii_in_free_text", [61], (row) => { row.summary = "Customer card 4111 1111 1111 1111 charged twice"; });
plant("tickets", "assignee_id", "orphan_foreign_key", [99], (row) => { row.assignee_id = 61; });
plant("subscriptions", "plan_id", "orphan_foreign_key", [30], (row) => { row.plan_id = 7; });
plant("coupons", "percent_off", "out_of_range", [19], (row) => { row.percent_off = 120; });
plant("reviews", "stars", "out_of_range", [77, 78], (row) => { row.stars = 6; });
plant("addresses", "postcode", "missing_required", [3], (row) => { row.postcode = ""; });

const csvField = (value) => { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
for (const table of Object.values(tables)) {
  const names = table.columns.map((column) => column.name);
  writeFileSync(join(input, "tables", `${table.name}.csv`), [names.join(","), ...table.rows.map((row) => names.map((name) => csvField(row[name])).join(","))].join("\n") + "\n");
}

const rule = (column) => [
  column.required ? "required" : "optional",
  column.key && "primary key (unique)",
  column.references && `references ${column.references}`,
  column.type === "money" || column.min !== undefined ? `>= ${column.min ?? 0}` : "",
  column.max !== undefined && `<= ${column.max}`,
  column.type === "currency" && "one of USD, EUR, GBP (upper case ISO 4217)",
  column.notAfterSnapshot && `not after ${SNAPSHOT}`,
  column.freeText && "free text: must not hold personal data (emails, phone numbers, card numbers)",
].filter(Boolean).join("; ");
writeFileSync(join(input, "SCHEMA.md"), `# Shop warehouse snapshot (${SNAPSHOT})

Twenty tables, one CSV each under \`tables/\` (header row first). Each column's rule is below; a value that
breaks its rule is a defect. Kinds of defect, by the name your findings must use:

| Kind | Breaks |
| --- | --- |
| \`missing_required\` | a required column is empty |
| \`duplicate_key\` | a primary key value appears on more than one row |
| \`orphan_foreign_key\` | a value with no matching row in the table it references |
| \`negative_amount\` | a value below its minimum (\`>= 0\` or \`>= 1\`) |
| \`out_of_range\` | a value above its maximum |
| \`future_date\` | a date after the snapshot date |
| \`invalid_currency\` | a currency that is not exactly USD, EUR or GBP |
| \`pii_in_free_text\` | personal data (an email, a phone number, a card number) in a free-text column |

${Object.values(tables).map((table) => `## ${table.name}\n\n${table.description} ${table.rows.length} rows.\n\n| Column | Type | Rule |\n| --- | --- | --- |\n${table.columns.map((column) => `| ${column.name} | ${column.type} | ${rule(column)} |`).join("\n")}\n`).join("\n")}`);

// Check the planted list is exactly what the schema's rules find, so no defect is planted by accident.
const found = audit();
const key = (defect) => `${defect.table}.${defect.column}.${defect.kind}`;
const planted = new Set(defects.map(key)), detected = new Set(found.map(key));
const extra = [...detected].filter((item) => !planted.has(item)), missed = [...planted].filter((item) => !detected.has(item));
if (extra.length || missed.length) throw new Error(`Rubric and data disagree: unplanted ${extra.join(", ") || "none"}; undetectable ${missed.join(", ") || "none"}`);
writeFileSync(join(hidden, "rubric.json"), JSON.stringify({ snapshot: SNAPSHOT, defects }, null, 1) + "\n");
console.log(`${Object.keys(tables).length} tables, ${defects.length} planted defects, clean: ${Object.keys(tables).filter((name) => !defects.some((defect) => defect.table === name)).join(", ")}`);

/** The rules applied to the generated rows, independently of how defects were planted. */
function audit() {
  const out = [];
  const keys = Object.fromEntries(Object.values(tables).map((table) => [table.name, new Set(table.rows.map((row) => String(row[table.columns.find((column) => column.key).name])))]));
  const pii = /[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d ]{8,}\d/;
  for (const table of Object.values(tables)) for (const column of table.columns) {
    const kinds = new Set();
    const seen = new Set();
    for (const row of table.rows) {
      const value = row[column.name] === undefined || row[column.name] === null ? "" : String(row[column.name]);
      if (value === "") { if (column.required) kinds.add("missing_required"); continue; }
      if (column.key) { if (seen.has(value)) kinds.add("duplicate_key"); seen.add(value); }
      if (column.references && !keys[column.references.split(".")[0]].has(value)) kinds.add("orphan_foreign_key");
      const min = column.min ?? (column.type === "money" ? 0 : undefined);
      if (min !== undefined && Number(value) < min) kinds.add("negative_amount");
      if (column.max !== undefined && Number(value) > column.max) kinds.add("out_of_range");
      if (column.notAfterSnapshot && value > SNAPSHOT) kinds.add("future_date");
      if (column.type === "currency" && !CURRENCIES.includes(value)) kinds.add("invalid_currency");
      if (column.freeText && pii.test(value)) kinds.add("pii_in_free_text");
    }
    for (const kind of kinds) out.push({ table: table.name, column: column.name, kind });
  }
  return out;
}
