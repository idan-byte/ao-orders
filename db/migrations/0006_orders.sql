-- Orders: reasons on deliveries, and one place that derives an order's status from its deliveries.

alter table deliveries add column cancel_reason text;
alter table deliveries add column exception_note text;
alter table deliveries add column status_before_hold delivery_status;
create index on orders (customer_id);

-- An order has no status of its own. With several deliveries it can be partly delivered without anyone tracking it by hand.
create view order_status as
select
    o.id as order_id,
    case
        when count(d.id) = 0                                    then 'draft'
        when bool_and(d.status = 'cancelled')                   then 'cancelled'
        when bool_and(d.status in ('delivered', 'cancelled'))   then 'delivered'
        when bool_or(d.status = 'delivered')                    then 'partially_delivered'
        when bool_or(d.status = 'exception')                    then 'exception'
        when bool_or(d.status = 'delayed')                      then 'delayed'
        else min(d.status) filter (where d.status <> 'cancelled')::text
    end as status
from orders o
left join deliveries d on d.order_id = o.id
group by o.id;
