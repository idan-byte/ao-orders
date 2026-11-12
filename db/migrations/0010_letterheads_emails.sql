-- Letterheads ("logo pages"): the heading a customer document is printed under. Each line of business can
-- have its own (hospitality trays, hot food, ...). A quote picks one; without a choice it uses the default.
create table letterheads (
    id              serial primary key,
    name            text not null unique,           -- how employees pick it: "מגשי אירוח"
    title           text not null,                  -- shown when there is no logo image, and as the image's description
    subtitle        text,                           -- address / phone line under the logo
    footer          text,                           -- small print at the bottom of the document
    logo            bytea,
    logo_mime       text,
    logo_updated_at timestamptz,
    is_default      boolean not null default false,
    active          boolean not null default true,
    created_at      timestamptz not null default now()
);
create unique index letterheads_one_default on letterheads (is_default) where is_default;

insert into letterheads (name, title, subtitle, is_default)
values ('כללי', 'אבי ועופר שירותי מזון בע״מ', 'A&O Food Services · אזור התעשייה עטרות, ירושלים', true);

alter table quotes add column letterhead_id int references letterheads(id);

-- Every email the system sends (or, without a mail server in development, would have sent).
create table emails (
    id           uuid primary key default gen_random_uuid(),
    entity_type  text not null,                    -- 'quote'
    entity_id    text not null,
    to_address   text not null,
    subject      text not null,
    body         text not null,
    attachment   text,                             -- file name of the attached PDF
    status       text not null check (status in ('sent', 'not_sent_dev', 'failed')),
    error        text,
    created_by   uuid references users(id),
    created_at   timestamptz not null default now()
);
create index on emails (entity_type, entity_id, created_at desc);
