-- Distribution, part 2: loading the vehicle, leaving for delivery, handing over at the customer.
alter table deliveries add column loaded_at timestamptz;
alter table deliveries add column loaded_by uuid references users(id);
create index on deliveries (daily_route_id) where loaded_at is not null;

alter table daily_routes add column departed_by uuid references users(id);
alter table daily_routes add column departure_note text;   -- why the route left without everything, when it did

-- Every loading and delivery action, and every refused attempt. Progress is always counted from the
-- deliveries themselves; this table is the history behind it.
create table shipping_events (
    id              bigserial primary key,
    delivery_id     uuid references deliveries(id),
    daily_route_id  uuid references daily_routes(id),
    event_type      text not null check (event_type in ('loaded', 'unloaded', 'load_reversed', 'unload_reversed', 'wrong_route_attempt', 'unload_before_load', 'departed', 'left_behind')),
    source          text not null default 'manual' check (source in ('manual', 'qr_scan', 'admin')),
    performed_by    uuid references users(id),
    metadata        jsonb,
    created_at      timestamptz not null default now()
);
create index on shipping_events (daily_route_id, created_at);
create index on shipping_events (delivery_id, created_at);
