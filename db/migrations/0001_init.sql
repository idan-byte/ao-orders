-- A&O order management: release 1 schema (sales, orders, production, delivery notes).
-- PostgreSQL. Not yet executed anywhere: written before Node.js and a database were available on the dev machine.
-- Conventions: unit prices numeric(12,4) before VAT (Hashavshevet keeps up to 3 decimals), document totals numeric(12,2),
-- timestamps in timestamptz, business dates in date (Israel time is applied in the application layer).

create type user_role as enum ('admin','company_manager','sales','order_clerk','dept_manager','production_worker','shipping_manager','loading_manager','driver','customer');
create type order_source as enum ('manual','standing','quote','email','whatsapp','website','portal');
create type delivery_status as enum ('draft','pending_approval','approved','in_production','ready_to_ship','shipped','delivered','exception','delayed','cancelled');
create type quote_status as enum ('draft','sent','follow_up','approved','rejected','expired');
create type lead_stage as enum ('new','quote_in_progress','sent','follow_up','won','lost');
create type billing_policy as enum ('per_delivery','monthly_summary');

-- ---------- users ----------
create table departments (
    id          serial primary key,
    name        text not null unique
);

create table users (
    id            uuid primary key default gen_random_uuid(),
    mobile        text not null unique,            -- login identifier, digits only, e.g. 0521234567
    full_name     text not null,
    role          user_role not null,
    department_id int references departments(id),  -- for dept_manager / production_worker
    customer_id   uuid,                            -- for role = customer (FK added below)
    active        boolean not null default true,
    created_at    timestamptz not null default now()
);

create table login_codes (
    id          bigserial primary key,
    mobile      text not null,
    code_hash   text not null,
    expires_at  timestamptz not null,
    attempts    int not null default 0,
    used_at     timestamptz
);
create index on login_codes (mobile, expires_at);

-- ---------- customers ----------
create table customers (
    id                 uuid primary key default gen_random_uuid(),
    name               text not null,
    tax_id             text,
    hash_account_key   text unique,                -- account key in Hashavshevet, null until linked
    payment_terms      text,
    billing_policy     billing_policy not null default 'per_delivery',
    fixed_discount_pct numeric(5,2) not null default 0,
    vat_exempt         boolean not null default false,
    notes              text,
    active             boolean not null default true,
    synced_at          timestamptz,
    created_at         timestamptz not null default now()
);
alter table users add constraint users_customer_fk foreign key (customer_id) references customers(id);

create table customer_contacts (
    id          uuid primary key default gen_random_uuid(),
    customer_id uuid not null references customers(id) on delete cascade,
    full_name   text not null,
    role_label  text,                              -- orders / receives on site / accounting
    phone       text,
    email       text
);

create table customer_addresses (
    id            uuid primary key default gen_random_uuid(),
    customer_id   uuid not null references customers(id) on delete cascade,
    label         text,
    street        text not null,
    city          text,
    delivery_area text,
    latitude      numeric(9,6),
    longitude     numeric(9,6),
    is_default    boolean not null default false
);

-- ---------- catalog ----------
create table products (
    sku               text primary key,            -- Hashavshevet item key, the business identifier
    name              text not null,
    sort_group        int,
    base_price        numeric(12,4) not null default 0,
    sales_unit        text,
    vat_exempt        boolean not null default false,
    hash_active       boolean not null default true, -- still present in Hashavshevet
    synced_at         timestamptz
);

-- Operational data that Hashavshevet does not hold. Never overwritten by the sync.
create table product_ops (
    sku            text primary key references products(sku),
    orderable      boolean not null default false,
    department_id  int references departments(id), -- null = service line, no production
    default_shift  smallint,                       -- 0 evening before, 1 night, 2 morning
    prep_minutes   int,
    production_unit text
);

create table product_variants (
    id      serial primary key,
    sku     text not null references products(sku),
    name    text not null,                         -- e.g. tuna, omelette, vegetarian
    active  boolean not null default true,
    unique (sku, name)
);

create table customer_prices (
    id          bigserial primary key,
    customer_id uuid not null references customers(id) on delete cascade,
    sku         text not null references products(sku),
    price       numeric(12,4) not null,
    valid_from  date not null default current_date,
    valid_to    date,
    source      text not null default 'manual',    -- manual / hashavshevet_last_price / hashavshevet_special
    approved_by uuid references users(id),
    unique (customer_id, sku, valid_from)
);

-- ---------- CRM ----------
create table leads (
    id            uuid primary key default gen_random_uuid(),
    customer_id   uuid references customers(id),
    contact_name  text,                            -- when the inquirer is not a customer yet
    contact_phone text,
    source        text not null,
    summary       text not null,
    stage         lead_stage not null default 'new',
    owner_id      uuid references users(id),
    lost_reason   text,
    created_at    timestamptz not null default now()
);

create table activities (
    id          bigserial primary key,
    customer_id uuid references customers(id),
    lead_id     uuid references leads(id),
    kind        text not null,                     -- call / email / message / note / system
    body        text not null,
    entity_type text,
    entity_id   text,
    user_id     uuid references users(id),
    created_at  timestamptz not null default now()
);
create index on activities (customer_id, created_at desc);

create table tasks (
    id          bigserial primary key,
    customer_id uuid references customers(id),
    lead_id     uuid references leads(id),
    title       text not null,
    due_date    date not null,
    owner_id    uuid references users(id),
    done_at     timestamptz
);

-- ---------- quotes ----------
create sequence quote_number_seq start 1000;
create table quotes (
    id            uuid primary key default gen_random_uuid(),
    number        int not null unique default nextval('quote_number_seq'),
    customer_id   uuid not null references customers(id),
    lead_id       uuid references leads(id),
    status        quote_status not null default 'draft',
    valid_until   date,
    payment_terms text,
    owner_id      uuid references users(id),
    created_at    timestamptz not null default now()
);

-- Each send freezes a version. Lines and totals of a sent version never change.
create table quote_versions (
    id               uuid primary key default gen_random_uuid(),
    quote_id         uuid not null references quotes(id) on delete cascade,
    version          int not null,
    discount_pct     numeric(5,2) not null default 0,
    delivery_fee     numeric(12,2) not null default 0,
    vat_rate         numeric(5,4) not null,        -- stored on the document, e.g. 0.18
    total_before_vat numeric(12,2) not null,
    total_vat        numeric(12,2) not null,
    customer_notes   text,
    internal_notes   text,
    sent_at          timestamptz,
    public_token     text unique,                  -- for the customer approval link
    approved_at      timestamptz,
    approved_by_name text,                         -- customer name typed on approval, or the employee for a manual approval
    approval_method  text,                         -- link / manual
    unique (quote_id, version)
);

create table quote_lines (
    id               bigserial primary key,
    quote_version_id uuid not null references quote_versions(id) on delete cascade,
    position         int not null,
    sku              text references products(sku), -- null only for a special line added with permission
    variant_id       int references product_variants(id),
    description      text not null,
    quantity         numeric(12,3) not null check (quantity > 0),
    unit_price       numeric(12,4) not null check (unit_price >= 0),
    discount_pct     numeric(5,2) not null default 0,
    delivery_date    date,
    vat_exempt       boolean not null default false
);

-- ---------- orders ----------
create sequence order_number_seq start 1000;
create table orders (
    id                uuid primary key default gen_random_uuid(),
    number            int not null unique default nextval('order_number_seq'),
    customer_id       uuid not null references customers(id),
    source            order_source not null,
    quote_version_id  uuid references quote_versions(id),
    standing_order_id uuid,
    owner_id          uuid references users(id),
    discount_pct      numeric(5,2) not null default 0,
    vat_rate          numeric(5,4) not null,
    notes             text,
    created_at        timestamptz not null default now()
);

-- The unit of work. Production, shipping and billing all derive from deliveries and their lines.
create table deliveries (
    id               uuid primary key default gen_random_uuid(),
    order_id         uuid not null references orders(id) on delete cascade,
    delivery_date    date not null,
    window_from      time,
    window_to        time,
    address_id       uuid references customer_addresses(id),
    address_snapshot text,
    status           delivery_status not null default 'draft',
    production_notes text,
    shipping_notes   text,
    shipped_at       timestamptz,
    shipped_by       uuid references users(id),
    delivered_at     timestamptz
);
create index on deliveries (delivery_date, status);

create table delivery_lines (
    id           bigserial primary key,
    delivery_id  uuid not null references deliveries(id) on delete cascade,
    sku          text not null references products(sku),
    variant_id   int references product_variants(id),
    quantity     numeric(12,3) not null check (quantity > 0),
    unit_price   numeric(12,4) not null check (unit_price >= 0),
    discount_pct numeric(5,2) not null default 0,
    shift        smallint,                          -- overrides product_ops.default_shift for this line
    produced_at  timestamptz,
    produced_by  uuid references users(id)
);
create index on delivery_lines (sku, variant_id);

-- ---------- standing orders ----------
create table standing_orders (
    id          uuid primary key default gen_random_uuid(),
    customer_id uuid not null references customers(id),
    address_id  uuid references customer_addresses(id),
    window_from time,
    window_to   time,
    valid_from  date not null,
    valid_to    date,
    paused_until date,
    notes       text
);
alter table orders add constraint orders_standing_fk foreign key (standing_order_id) references standing_orders(id);

create table standing_order_lines (
    id                bigserial primary key,
    standing_order_id uuid not null references standing_orders(id) on delete cascade,
    weekday           smallint not null check (weekday between 0 and 6), -- 0 = Sunday
    sku               text not null references products(sku),
    variant_id        int references product_variants(id),
    quantity          numeric(12,3) not null check (quantity > 0)
);

-- A single date that differs from the template: cancelled, or generated once already.
create table standing_order_days (
    standing_order_id uuid not null references standing_orders(id) on delete cascade,
    day               date not null,
    skipped           boolean not null default false,
    generated_order_id uuid references orders(id),
    primary key (standing_order_id, day)            -- makes generation idempotent
);

-- ---------- production ----------
create table production_plans (
    id            uuid primary key default gen_random_uuid(),
    plan_date     date not null,                    -- delivery date being produced
    department_id int not null references departments(id),
    shift         smallint not null,
    locked_at     timestamptz,
    locked_by     uuid references users(id),
    snapshot      jsonb,                            -- aggregated quantities at lock time
    unique (plan_date, department_id, shift)
);

create table production_changes (
    id               bigserial primary key,
    plan_id          uuid not null references production_plans(id) on delete cascade,
    delivery_line_id bigint references delivery_lines(id),
    sku              text not null,
    variant_id       int,
    old_quantity     numeric(12,3) not null,
    new_quantity     numeric(12,3) not null,
    changed_by       uuid references users(id),
    changed_at       timestamptz not null default now(),
    acknowledged_by  uuid references users(id),
    acknowledged_at  timestamptz
);

-- ---------- delivery notes ----------
create sequence delivery_note_number_seq start 1;
create table delivery_notes (
    id              uuid primary key default gen_random_uuid(),
    number          int not null unique default nextval('delivery_note_number_seq'),
    delivery_id     uuid not null references deliveries(id),
    issued_at       timestamptz not null default now(),
    issued_by       uuid references users(id),
    idempotency_key text not null unique,           -- one note per "shipped" action, even on a double click
    hash_doc_number int,                            -- document number in Hashavshevet once transferred
    hash_synced_at  timestamptz
);

create table delivery_note_lines (
    id               bigserial primary key,
    delivery_note_id uuid not null references delivery_notes(id) on delete cascade,
    delivery_line_id bigint not null references delivery_lines(id),
    quantity         numeric(12,3) not null check (quantity > 0)
);

-- ---------- audit and sync ----------
create table audit_log (
    id          bigserial primary key,
    user_id     uuid references users(id),
    action      text not null,
    entity_type text not null,
    entity_id   text not null,
    before      jsonb,
    after       jsonb,
    created_at  timestamptz not null default now()
);
create index on audit_log (entity_type, entity_id, created_at desc);

create table sync_runs (
    id          bigserial primary key,
    kind        text not null,                      -- catalog / customers / last_prices
    started_at  timestamptz not null default now(),
    finished_at timestamptz,
    rows_read   int,
    rows_changed int,
    error       text
);
