-- Automatic locking of the production plan: for each department and shift, when the plan of a delivery
-- date locks by itself. No row = that shift is locked by hand only.
create table production_lock_times (
    department_id int not null references departments(id),
    shift         smallint not null check (shift between 0 and 2),
    day_offset    smallint not null check (day_offset between 0 and 3),  -- 0 = on the delivery day, 1 = the day before, ...
    lock_time     time not null,                                          -- Israel time
    updated_at    timestamptz not null default now(),
    updated_by    uuid references users(id),
    primary key (department_id, shift)
);

-- Set once when the scheduler locks a plan. A plan that a manager unlocked afterwards keeps this mark,
-- so the scheduler does not lock it again behind the manager's back.
alter table production_plans add column auto_locked_at timestamptz;
