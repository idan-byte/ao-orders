-- Every box of a delivery has its own label, its own scan code and its own loaded / handed-over state.
-- The codes exist to make sure every box gets on the vehicle, so one scan never stands for several boxes:
-- a delivery counts as loaded only when all its boxes are.
create table delivery_boxes (
    id           bigserial primary key,
    delivery_id  uuid not null references deliveries(id),
    seq          int not null,                         -- 1..n within the delivery, printed as "box 2 of 3"
    kind         text not null default 'general' check (kind in ('general', 'hot', 'cold')),
    scan_code    text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
    loaded_at    timestamptz,
    loaded_by    uuid references users(id),
    unloaded_at  timestamptz,
    unloaded_by  uuid references users(id),
    unique (delivery_id, seq)
);
create index on delivery_boxes (delivery_id);

-- Existing deliveries: the first box keeps the code that may already be printed, the others get new codes.
-- Boxes of a delivery that was marked loaded or delivered are in the same state.
insert into delivery_boxes (delivery_id, seq, scan_code, loaded_at, loaded_by, unloaded_at)
select d.id, 1, d.scan_code, d.loaded_at, d.loaded_by, d.delivered_at from deliveries d;
insert into delivery_boxes (delivery_id, seq, loaded_at, loaded_by, unloaded_at)
select d.id, g, d.loaded_at, d.loaded_by, d.delivered_at from deliveries d cross join lateral generate_series(2, d.package_count) g;

alter table deliveries drop column scan_code;
alter table deliveries drop column package_count;

-- A delivery always has at least one box, wherever in the system it is created.
create function delivery_first_box() returns trigger language plpgsql as $$
begin
  insert into delivery_boxes (delivery_id, seq) values (new.id, 1);
  return new;
end $$;
create trigger delivery_first_box after insert on deliveries for each row execute function delivery_first_box();

alter table shipping_events drop constraint shipping_events_event_type_check;
alter table shipping_events add constraint shipping_events_event_type_check
  check (event_type in ('loaded', 'unloaded', 'load_reversed', 'unload_reversed', 'wrong_route_attempt', 'unload_before_load', 'departed', 'left_behind', 'route_closed', 'unknown_code', 'box_loaded', 'box_unloaded'));
