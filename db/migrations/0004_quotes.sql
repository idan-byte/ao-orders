-- Quotes: delivery details on the version, delivery fee on the order, and one order per approved version.

alter table quote_versions add column delivery_date date;
alter table quote_versions add column window_from time;
alter table quote_versions add column window_to time;
alter table quote_versions add column address_id uuid references customer_addresses(id);
alter table quote_versions add column total numeric(12,2);
alter table quote_versions add column created_at timestamptz not null default now();

alter table quotes add column lost_reason text;

alter table orders add column delivery_fee numeric(12,2) not null default 0;

-- Approving the same version twice must never open a second order.
create unique index orders_one_per_quote_version on orders (quote_version_id) where quote_version_id is not null;
