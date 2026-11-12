-- Hot food, part 1: institutions and their groups, meal types, and the quantities read from Milgam files.

create table feeding_programs (
    id    serial primary key,
    name  text not null unique          -- as written in the Milgam file: יוחא, ניצנים מילגם ...
);

-- The meal-type vocabulary of Milgam ("חמגשית ג-ו", "תפזורת חובה" ...). Each is mapped once to a Hashavshevet SKU.
create table meal_types (
    id      serial primary key,
    name    text not null unique,
    sku     text references products(sku),
    active  boolean not null default true
);

-- An institution is a delivery point. Its key is Milgam's institution symbol, kept as text ("615955-1" exists).
create table institutions (
    id               serial primary key,
    symbol           text not null unique,
    name             text not null,
    kind             text,                               -- בית ספר / גן
    authority        text,                               -- רשות
    address          text,                               -- delivery address as written by Milgam
    kosher           text,
    notes            text,                               -- Milgam's remarks for the institution, whole and unshortened
    life_threatening boolean not null default false,     -- "יש אלרגיות מסכנות חיים"
    customer_id      uuid references customers(id),      -- who is billed; linked by a person, never guessed
    address_id       uuid references customer_addresses(id),
    active           boolean not null default true,
    created_at       timestamptz not null default now()
);

-- A group ("מסגרת") is one class of one institution. It is the unit that gets one hot box and one cold box.
create table institution_groups (
    id              serial primary key,
    institution_id  int not null references institutions(id),
    class_name      text not null,
    program_id      int references feeding_programs(id),
    unique (institution_id, class_name)
);

create table milgam_imports (
    id           serial primary key,
    kind         text not null check (kind in ('forecast', 'daily')),
    file_name    text not null,
    uploaded_by  uuid references users(id),
    uploaded_at  timestamptz not null default now(),
    file_rows    int not null,
    cells        int not null,           -- quantities written
    portions     int not null,
    day_from     date,
    day_to       date,
    added        jsonb,                  -- institutions and meal types this import created
    held         jsonb                   -- rows that were not taken in, and why
);

-- One line per group, meal type and day. The forecast and the order are kept side by side, so they can be compared.
create table milgam_quantities (
    group_id       int not null references institution_groups(id),
    meal_type_id   int not null references meal_types(id),
    day            date not null,
    forecast_qty   int check (forecast_qty > 0),
    ordered_qty    int check (ordered_qty > 0),
    forecast_import_id int references milgam_imports(id),
    ordered_import_id  int references milgam_imports(id),
    primary key (group_id, meal_type_id, day)
);
create index on milgam_quantities (day);

-- The days for which a daily order was loaded. On such a day a line without an ordered quantity means "not ordered".
create table milgam_order_days (
    day        date primary key,
    import_id  int not null references milgam_imports(id),
    loaded_at  timestamptz not null default now()
);
