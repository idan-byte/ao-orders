-- The files attached to a kept request or order are kept with it, so a person can open them from the recommendation.
-- read_by_ai says whether the file was also read by the AI when the recommendation was made (PDF or image only).
-- Files of a message that is neither a request nor an order are never kept.

create table inbound_files (
    id           uuid primary key default gen_random_uuid(),
    inbound_id   uuid not null references inbound_emails(id) on delete cascade,
    name         text not null,
    mime         text not null default '',
    size         integer not null,
    read_by_ai   boolean not null default false,
    data         bytea not null
);
create index on inbound_files (inbound_id);
