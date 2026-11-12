-- Distribution alerts and exceptions.
-- An alert that comes from an event (a delivery left behind, a refused attempt) stays open until someone marks it handled.
alter table shipping_events add column resolved_at timestamptz;
alter table shipping_events add column resolved_by uuid references users(id);
alter table shipping_events add column resolution text;

-- A route can be closed although something was not delivered; that is an event of its own.
alter table shipping_events drop constraint shipping_events_event_type_check;
alter table shipping_events add constraint shipping_events_event_type_check
    check (event_type in ('loaded', 'unloaded', 'load_reversed', 'unload_reversed', 'wrong_route_attempt', 'unload_before_load', 'departed', 'left_behind', 'route_closed'));
