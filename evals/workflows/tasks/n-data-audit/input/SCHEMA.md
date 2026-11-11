# Shop warehouse snapshot (2026-10-31)

Twenty tables, one CSV each under `tables/` (header row first). Each column's rule is below; a value that
breaks its rule is a defect. Kinds of defect, by the name your findings must use:

| Kind | Breaks |
| --- | --- |
| `missing_required` | a required column is empty |
| `duplicate_key` | a primary key value appears on more than one row |
| `orphan_foreign_key` | a value with no matching row in the table it references |
| `negative_amount` | a value below its minimum (`>= 0` or `>= 1`) |
| `out_of_range` | a value above its maximum |
| `future_date` | a date after the snapshot date |
| `invalid_currency` | a currency that is not exactly USD, EUR or GBP |
| `pii_in_free_text` | personal data (an email, a phone number, a card number) in a free-text column |

## customers

People and companies that buy from us. 121 rows.

| Column | Type | Rule |
| --- | --- | --- |
| customer_id | integer | required; primary key (unique) |
| name | text | required |
| email | email | required |
| country | text | required |
| notes | text | optional; free text: must not hold personal data (emails, phone numbers, card numbers) |

## suppliers

Companies we buy stock from. 30 rows.

| Column | Type | Rule |
| --- | --- | --- |
| supplier_id | integer | required; primary key (unique) |
| name | text | required |
| contact_email | email | required |
| currency | currency | required; one of USD, EUR, GBP (upper case ISO 4217) |

## products

What we sell. 80 rows.

| Column | Type | Rule |
| --- | --- | --- |
| product_id | integer | required; primary key (unique) |
| supplier_id | integer | required; references suppliers.supplier_id |
| name | text | required |
| unit_price | money | required; >= 0 |
| currency | currency | required; one of USD, EUR, GBP (upper case ISO 4217) |

## warehouses

Where stock is kept. 12 rows.

| Column | Type | Rule |
| --- | --- | --- |
| warehouse_id | integer | required; primary key (unique) |
| city | text | required |
| opened_on | date | required; not after 2026-10-31 |

## inventory

Stock on hand per product and warehouse. 150 rows.

| Column | Type | Rule |
| --- | --- | --- |
| inventory_id | integer | required; primary key (unique) |
| product_id | integer | required; references products.product_id |
| warehouse_id | integer | required; references warehouses.warehouse_id |
| quantity | integer | required; >= 0 |
| counted_on | date | required; not after 2026-10-31 |

## orders

Customer orders. 200 rows.

| Column | Type | Rule |
| --- | --- | --- |
| order_id | integer | required; primary key (unique) |
| customer_id | integer | required; references customers.customer_id |
| ordered_on | date | required; not after 2026-10-31 |
| currency | currency | required; one of USD, EUR, GBP (upper case ISO 4217) |
| notes | text | optional; free text: must not hold personal data (emails, phone numbers, card numbers) |

## order_items

Lines of an order. 300 rows.

| Column | Type | Rule |
| --- | --- | --- |
| order_item_id | integer | required; primary key (unique) |
| order_id | integer | required; references orders.order_id |
| product_id | integer | required; references products.product_id |
| quantity | integer | required; >= 1 |
| line_total | money | required; >= 0 |

## invoices

What we billed. 182 rows.

| Column | Type | Rule |
| --- | --- | --- |
| invoice_id | integer | required; primary key (unique) |
| order_id | integer | required; references orders.order_id |
| issued_on | date | required; not after 2026-10-31 |
| amount | money | required; >= 0 |
| currency | currency | required; one of USD, EUR, GBP (upper case ISO 4217) |

## payments

Money received against invoices. 170 rows.

| Column | Type | Rule |
| --- | --- | --- |
| payment_id | integer | required; primary key (unique) |
| invoice_id | integer | required; references invoices.invoice_id |
| paid_on | date | required; not after 2026-10-31 |
| amount | money | required; >= 0 |
| method | text | required |

## refunds

Money returned. 40 rows.

| Column | Type | Rule |
| --- | --- | --- |
| refund_id | integer | required; primary key (unique) |
| payment_id | integer | required; references payments.payment_id |
| amount | money | required; >= 0 |
| reason | text | optional; free text: must not hold personal data (emails, phone numbers, card numbers) |

## shipments

Parcels sent for orders. 160 rows.

| Column | Type | Rule |
| --- | --- | --- |
| shipment_id | integer | required; primary key (unique) |
| order_id | integer | required; references orders.order_id |
| warehouse_id | integer | required; references warehouses.warehouse_id |
| shipped_on | date | required; not after 2026-10-31 |
| carrier | text | required |

## departments

Teams. 8 rows.

| Column | Type | Rule |
| --- | --- | --- |
| department_id | integer | required; primary key (unique) |
| name | text | required |

## employees

Staff. 60 rows.

| Column | Type | Rule |
| --- | --- | --- |
| employee_id | integer | required; primary key (unique) |
| department_id | integer | required; references departments.department_id |
| name | text | required |
| work_email | email | required |
| hired_on | date | required; not after 2026-10-31 |

## tickets

Support tickets. 140 rows.

| Column | Type | Rule |
| --- | --- | --- |
| ticket_id | integer | required; primary key (unique) |
| customer_id | integer | required; references customers.customer_id |
| assignee_id | integer | required; references employees.employee_id |
| opened_on | date | required; not after 2026-10-31 |
| summary | text | required; free text: must not hold personal data (emails, phone numbers, card numbers) |

## ticket_events

What happened on a ticket. 250 rows.

| Column | Type | Rule |
| --- | --- | --- |
| event_id | integer | required; primary key (unique) |
| ticket_id | integer | required; references tickets.ticket_id |
| at | date | required; not after 2026-10-31 |
| kind | text | required |

## plans

Subscription plans. 6 rows.

| Column | Type | Rule |
| --- | --- | --- |
| plan_id | integer | required; primary key (unique) |
| name | text | required |
| monthly_price | money | required; >= 0 |
| currency | currency | required; one of USD, EUR, GBP (upper case ISO 4217) |

## subscriptions

Customers on plans. 90 rows.

| Column | Type | Rule |
| --- | --- | --- |
| subscription_id | integer | required; primary key (unique) |
| customer_id | integer | required; references customers.customer_id |
| plan_id | integer | required; references plans.plan_id |
| started_on | date | required; not after 2026-10-31 |

## coupons

Discount codes. 25 rows.

| Column | Type | Rule |
| --- | --- | --- |
| coupon_id | integer | required; primary key (unique) |
| code | text | required |
| percent_off | integer | required; >= 0; <= 100 |

## reviews

Product reviews. 130 rows.

| Column | Type | Rule |
| --- | --- | --- |
| review_id | integer | required; primary key (unique) |
| product_id | integer | required; references products.product_id |
| customer_id | integer | required; references customers.customer_id |
| stars | integer | required; >= 1; <= 5 |
| body | text | optional; free text: must not hold personal data (emails, phone numbers, card numbers) |

## addresses

Shipping addresses. 110 rows.

| Column | Type | Rule |
| --- | --- | --- |
| address_id | integer | required; primary key (unique) |
| customer_id | integer | required; references customers.customer_id |
| line1 | text | required |
| city | text | required |
| postcode | text | required |
