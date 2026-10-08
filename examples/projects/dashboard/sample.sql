-- A small shop's 2025: products, customers and their orders. Generated the same way each time.

CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, price REAL NOT NULL);
INSERT INTO products (id, name, category, price) VALUES
  (1, 'Trail Runner', 'Shoes', 120), (2, 'City Sneaker', 'Shoes', 85), (3, 'Hiking Boot', 'Shoes', 160),
  (4, 'Rain Shell', 'Jackets', 140), (5, 'Down Parka', 'Jackets', 260), (6, 'Fleece', 'Jackets', 70),
  (7, 'Daypack', 'Bags', 65), (8, 'Duffel', 'Bags', 95), (9, 'Sling', 'Bags', 35),
  (10, 'Wool Socks', 'Accessories', 18), (11, 'Beanie', 'Accessories', 25), (12, 'Water Bottle', 'Accessories', 22);

CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL, joined TEXT NOT NULL);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
INSERT INTO customers (id, name, region, joined)
SELECT i, 'Customer ' || i,
  CASE WHEN i % 10 < 4 THEN 'North' WHEN i % 10 < 7 THEN 'South' WHEN i % 10 < 9 THEN 'East' ELSE 'West' END,
  date('2024-01-01', '+' || ((i * 37) % 600) || ' days')
FROM n;

CREATE TABLE orders (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL, ordered_at TEXT NOT NULL, status TEXT NOT NULL
);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4000)
INSERT INTO orders (id, customer_id, product_id, quantity, ordered_at, status)
SELECT i, 1 + (i * 7919) % 300, 1 + (i * 104729 + i / 13) % 12, 1 + (i * 31) % 3,
  -- Half spread over the year, half leaning toward the holidays: sales grow as the year goes on.
  date('2025-01-01', '+' || CASE WHEN i % 2 = 0 THEN (i * 7) % 365 ELSE 364 - ((i * 7919) % 365) * ((i * 7919) % 365) / 365 END || ' days'),
  CASE WHEN i % 23 = 0 THEN 'refunded' WHEN i % 11 = 0 THEN 'cancelled' ELSE 'completed' END
FROM n;
