-- Hot food, part 3: menus. A menu has a name; every institution follows one menu; for every date the menu
-- says which dishes are cooked, by category. This is what the kitchen reads instead of "400 portions".

create table menus (
    id          serial primary key,
    name        text not null unique,
    active      boolean not null default true,
    created_at  timestamptz not null default now()
);

alter table institutions add column menu_id int references menus(id);

create table menu_dishes (
    id        serial primary key,
    menu_id   int not null references menus(id),
    day       date not null,
    category  text not null check (category in ('main', 'side', 'vegetable', 'vegetarian', 'other')),
    name      text not null check (length(btrim(name)) > 0),
    position  int not null default 0,
    unique (menu_id, day, category, name)
);
create index on menu_dishes (day);
