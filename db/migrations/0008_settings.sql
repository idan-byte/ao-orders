-- System settings that are changed from the screens (not from environment files), one row per setting.
-- First use: automatic generation of orders from standing orders ('standing_auto', 'standing_auto_last').
create table settings (
    key         text primary key,
    value       jsonb not null,
    updated_at  timestamptz not null default now(),
    updated_by  uuid references users(id)
);
