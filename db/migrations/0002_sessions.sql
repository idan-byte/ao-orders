-- Login sessions and rate limiting for one-time codes.

create table sessions (
    id          bigserial primary key,
    token_hash  text not null unique,              -- sha256 of the cookie token; the token itself is never stored
    user_id     uuid not null references users(id) on delete cascade,
    created_at  timestamptz not null default now(),
    expires_at  timestamptz not null
);
create index on sessions (user_id);

alter table login_codes add column created_at timestamptz not null default now();
