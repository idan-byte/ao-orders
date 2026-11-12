-- Hot food, part 2: Milgam's daily order becomes deliveries, with one hot box and one cold box for every group.
alter type order_source add value if not exists 'milgam';

-- The delivery that was made for an institution on a day. One at most, so making deliveries again updates it.
create table milgam_deliveries (
    institution_id  int not null references institutions(id),
    day             date not null,
    delivery_id     uuid not null unique references deliveries(id),
    created_at      timestamptz not null default now(),
    primary key (institution_id, day)
);

-- A box of a hot food delivery belongs to a group (a class or a kindergarten): its hot box or its cold box.
alter table delivery_boxes add column group_id int references institution_groups(id);
create unique index on delivery_boxes (delivery_id, group_id, kind) where group_id is not null;
