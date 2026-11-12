-- CRM: lead bookkeeping, task authorship, and one place that says which stage a lead is in.

alter table leads add column closed_at timestamptz;
alter table tasks add column created_at timestamptz not null default now();
alter table tasks add column created_by uuid references users(id);
create index on tasks (due_date) where done_at is null;
create index on activities (lead_id, created_at desc);
create index on quotes (lead_id);

-- The stage shown on the board is derived, not typed in: once a lead has a quote, the quote decides.
-- A lead without a quote keeps the stage stored on it (new, follow_up or lost).
create view lead_board as
select
    l.id,
    l.customer_id,
    coalesce(c.name, l.contact_name) as display_name,
    l.contact_name,
    l.contact_phone,
    l.source,
    l.summary,
    l.owner_id,
    l.created_at,
    qt.id          as quote_id,
    qt.number      as quote_number,
    qv.total       as quote_total,
    case
        when l.stage = 'lost'                   then 'lost'
        when qt.status = 'approved'             then 'won'
        when qt.status = 'rejected'             then 'lost'
        when qt.status in ('sent', 'follow_up') then case when l.stage = 'follow_up' then 'follow_up' else 'sent' end
        when qt.id is not null                  then 'quote_in_progress'
        else l.stage::text
    end as stage,
    coalesce(l.lost_reason, qt.lost_reason) as lost_reason
from leads l
left join customers c on c.id = l.customer_id
left join lateral (
    select q.id, q.number, q.status, q.lost_reason
    from quotes q where q.lead_id = l.id
    order by q.created_at desc limit 1
) qt on true
left join lateral (
    select v.total from quote_versions v where v.quote_id = qt.id order by v.version desc limit 1
) qv on true;
