-- A scan code for every delivery: what the QR on its label carries, and what is typed when a label cannot be read.
-- Ten characters of 0-9 and A-F, random, so a code says nothing about the customer or the order.
-- The code is not a permission: scanning still needs a signed-in user who may work that route.
alter table deliveries add column scan_code text not null default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
create unique index on deliveries (scan_code);

-- A scan of something that is not one of our labels is kept in the history too.
alter table shipping_events drop constraint shipping_events_event_type_check;
alter table shipping_events add constraint shipping_events_event_type_check
  check (event_type in ('loaded', 'unloaded', 'load_reversed', 'unload_reversed', 'wrong_route_attempt', 'unload_before_load', 'departed', 'left_behind', 'route_closed', 'unknown_code'));
