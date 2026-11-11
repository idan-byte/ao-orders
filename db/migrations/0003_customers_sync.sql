-- Customer fields that mirror Hashavshevet, and review state for price agreements.

alter table customers add column hash_phone text;
alter table customers add column hash_address text;
alter table customers add column hash_city text;
alter table customers add column last_document_date date;

-- A price row is "pending review" until someone approves it. Only approved rows are used for pricing.
alter table customer_prices add column approved_at timestamptz;
alter table customer_prices add column source_note text;
create index on customer_prices (customer_id, sku);
