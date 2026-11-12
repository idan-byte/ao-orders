-- Production plan and standing orders.

-- Days the factory does not deliver (holidays). Standing orders skip them.
create table closed_days (
    day     date primary key,
    reason  text not null
);

alter table standing_orders add column shipping_notes text;
alter table standing_orders add column created_at timestamptz not null default now();
alter table standing_orders add column created_by uuid references users(id);
alter table standing_order_days add column reason text;
create index on standing_order_lines (standing_order_id, weekday);

-- What one department has to make for one delivery date, summed across all orders.
-- Cancelled, draft and not-yet-approved deliveries never reach production.
create view production_rows as
select
    d.delivery_date,
    o.department_id,
    coalesce(l.shift, o.default_shift, 2)::smallint as shift,
    l.sku,
    p.name                         as product,
    l.variant_id,
    v.name                         as variant,
    sum(l.quantity)                as quantity,
    count(*)::int                  as lines,
    count(l.produced_at)::int      as produced_lines
from delivery_lines l
join deliveries d   on d.id = l.delivery_id
join products p     on p.sku = l.sku
join product_ops o  on o.sku = l.sku
left join product_variants v on v.id = l.variant_id
where d.status in ('approved', 'in_production', 'ready_to_ship', 'shipped', 'delivered')
  and o.department_id is not null
group by d.delivery_date, o.department_id, coalesce(l.shift, o.default_shift, 2), l.sku, p.name, l.variant_id, v.name;
