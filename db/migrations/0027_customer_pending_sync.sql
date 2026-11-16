-- A customer created in this system (not from Hashavshevet). It still has to be entered in Hashavshevet, so it is marked
-- until that happens. The Hashavshevet sync never removes or deactivates customers, so the mark is kept.
alter table customers add column pending_hash_sync boolean not null default false;
