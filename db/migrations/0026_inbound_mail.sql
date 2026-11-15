-- Incoming mail: the mailbox is read (never changed), every new message is sorted by the AI into a request for a
-- quote, an order, or neither, and for the first two a recommendation is kept until a person approves or dismisses
-- it. Nothing becomes a quote or an order without that approval. A message that is neither keeps no body.

-- Where the reading of each mailbox stands.
create table inbound_state (
    mailbox       text primary key,
    uid_validity  bigint,
    last_uid      bigint not null default 0,
    checked_at    timestamptz,
    last_error    text
);

create table inbound_emails (
    id              uuid primary key default gen_random_uuid(),
    mailbox         text not null,
    message_id      text not null unique,
    from_email      text not null,
    from_name       text,
    subject         text not null default '',
    received_at     timestamptz not null,
    body            text,                       -- kept only for a request or an order
    attachments     jsonb not null default '[]', -- names and sizes; the files themselves are not kept
    kind            text not null check (kind in ('quote_request', 'order', 'other')),
    status          text not null default 'new' check (status in ('new', 'approved', 'dismissed')),
    customer_id     uuid references customers(id),
    analysis        jsonb,                      -- the recommendation: summary, delivery date, lines matched to existing SKUs
    quote_id        uuid references quotes(id),
    order_id        uuid references orders(id),
    handled_by      uuid references users(id),
    handled_at      timestamptz,
    dismiss_reason  text,
    created_at      timestamptz not null default now()
);
create index on inbound_emails (status, received_at desc);
