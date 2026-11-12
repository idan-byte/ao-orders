-- Distribution, part 1: permanent routes, drivers and vehicles, and the daily assignment of deliveries to routes.
-- Hierarchy: day -> daily route -> stop (a delivery address) -> delivery. Boxes join in the hot-food release.

create table vehicles (
    id            serial primary key,
    registration  text not null unique,
    description   text,
    active        boolean not null default true
);

-- A driver and their vehicle are one working unit: choosing the driver for a day brings the vehicle along.
create table drivers (
    id          serial primary key,
    name        text not null,
    phone       text,
    vehicle_id  int references vehicles(id),
    user_id     uuid unique references users(id),   -- the driver's login, once drivers work from a phone
    active      boolean not null default true,
    created_at  timestamptz not null default now()
);

-- A permanent delivery line. It does not depend on who drives it on a given day.
create table routes (
    id                 serial primary key,
    name               text not null unique,
    description        text,
    default_driver_id  int references drivers(id),
    active             boolean not null default true,
    created_at         timestamptz not null default now()
);

-- The permanent line of a delivery address and its place in the delivery order.
alter table customer_addresses add column route_id int references routes(id);
alter table customer_addresses add column route_order int;
create index on customer_addresses (route_id, route_order);

-- One line on one date: a snapshot. Changing it never changes the permanent line.
create table daily_routes (
    id                    uuid primary key default gen_random_uuid(),
    route_date            date not null,
    route_id              int not null references routes(id),
    driver_id             int references drivers(id),
    vehicle_id            int references vehicles(id),
    mode                  text not null default 'loading' check (mode in ('loading', 'unloading')),
    loading_started_at    timestamptz,
    loading_completed_at  timestamptz,
    delivery_started_at   timestamptz,
    delivery_completed_at timestamptz,
    created_at            timestamptz not null default now(),
    unique (route_date, route_id)
);

alter table deliveries add column daily_route_id uuid references daily_routes(id);
alter table deliveries add column stop_order int;   -- deliveries to the same address share a stop number
create index on deliveries (daily_route_id, stop_order);
