-- Communication management.
-- Incoming sources: the email addresses and WhatsApp numbers that inquiries arrive at (the leads and quotes inbox).
create table comm_channels (
    id          serial primary key,
    kind        text not null check (kind in ('email', 'whatsapp')),
    address     text not null,          -- an email address in lower case, or a phone number as digits (0XXXXXXXXX)
    label       text,                   -- what it is used for, in the business's own words
    active      boolean not null default true,
    created_at  timestamptz not null default now(),
    created_by  uuid references users(id),
    unique (kind, address)
);

-- Which incoming source an inquiry arrived at. Filled by hand today; automatic intake will fill it by itself.
alter table leads add column channel_id int references comm_channels(id);

-- The sender of documents (one email identity, one WhatsApp account) is kept in settings under 'comm_outgoing'.
