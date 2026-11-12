import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";

const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 });
const dateFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", weekday: "long", day: "numeric", month: "long", year: "numeric" });

// The page shell renders instantly; the data-dependent part streams in behind the Suspense boundary.
export default function Home() {
  return (
    <Suspense fallback={<Loading />}>
      <HomeContent />
    </Suspense>
  );
}

async function HomeContent() {
  const { user, allowed } = await requirePermission("dashboard.view");
  // Production staff have no dashboard: they go straight to their plan.
  if (!allowed && can(user.role, "production.view")) redirect("/production");
  // Drivers and loading staff go straight to their routes.
  if (!allowed && can(user.role, "shipping.ship")) redirect("/drive");
  if (!allowed) return <NoAccess />;

  const [s] = await query<{
    today: string; open_leads: number; tasks_due: number; tasks_overdue: number; quotes_waiting: number; quotes_waiting_sum: number; quotes_expired: number;
    quotes_draft: number; deliveries_week: number; orders_sum_week: number; pending_prices: number; customers: number;
  }>(`
    with t as (select (now() at time zone 'Asia/Jerusalem')::date as today)
    select t.today::text,
      (select count(*)::int from lead_board where stage not in ('won', 'lost')) as open_leads,
      (select count(*)::int from tasks where done_at is null and due_date <= t.today) as tasks_due,
      (select count(*)::int from tasks where done_at is null and due_date < t.today) as tasks_overdue,
      (select count(*)::int from quotes where status in ('sent', 'follow_up') and coalesce(valid_until >= t.today, true)) as quotes_waiting,
      coalesce((select sum(v.total) from quotes q join quote_versions v on v.quote_id = q.id and v.version = (select max(version) from quote_versions where quote_id = q.id)
                where q.status in ('sent', 'follow_up') and coalesce(q.valid_until >= t.today, true)), 0)::float as quotes_waiting_sum,
      (select count(*)::int from quotes where status in ('sent', 'follow_up') and valid_until < t.today) as quotes_expired,
      (select count(*)::int from quotes where status = 'draft') as quotes_draft,
      (select count(*)::int from deliveries where status not in ('cancelled', 'draft') and delivery_date between t.today and t.today + 7) as deliveries_week,
      coalesce((select sum(l.quantity * l.unit_price * (1 - l.discount_pct / 100)) from delivery_lines l join deliveries d on d.id = l.delivery_id
                where d.status not in ('cancelled', 'draft') and d.delivery_date between t.today and t.today + 7), 0)::float as orders_sum_week,
      (select count(*)::int from customer_prices where approved_at is null) as pending_prices,
      (select count(*)::int from customers where active) as customers
    from t`);

  const sales = can(user.role, "leads.view");
  const quotes = can(user.role, "quotes.view");
  const prices = can(user.role, "prices.view");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-2xl font-bold">שלום, {user.fullName}</h1>
        <p className="text-muted">{dateFmt.format(new Date(s.today))}</p>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3" data-tiles>
        {sales ? <Tile href="/sales" value={s.tasks_due} label="משימות מעקב להיום" note={s.tasks_overdue > 0 ? `${s.tasks_overdue} באיחור` : undefined} id="tile-tasks" /> : null}
        {sales ? <Tile href="/sales" value={s.open_leads} label="פניות פתוחות" id="tile-leads" /> : null}
        {quotes ? <Tile href="/quotes?status=sent" value={s.quotes_waiting} label="הצעות ממתינות ללקוח" note={prices && s.quotes_waiting_sum > 0 ? `${money.format(s.quotes_waiting_sum)} כולל מע״מ` : undefined} id="tile-waiting" /> : null}
        {quotes ? <Tile href="/quotes?status=sent" value={s.quotes_expired} label="הצעות שנשלחו ותוקפן פג" id="tile-expired" /> : null}
        {quotes ? <Tile href="/quotes?status=draft" value={s.quotes_draft} label="הצעות בטיוטה" id="tile-drafts" /> : null}
        <Tile href={can(user.role, "orders.view") ? "/orders" : undefined} value={s.deliveries_week} label="אספקות מאושרות לשבוע הקרוב" note={prices && s.orders_sum_week > 0 ? `${money.format(s.orders_sum_week)} לפני מע״מ` : undefined} id="tile-deliveries" />
        {prices ? <Tile href="/customers?pending=1" value={s.pending_prices} label="מחירי לקוח ממתינים לבדיקה" id="tile-prices" /> : null}
      </div>

      <p className="max-w-prose text-sm text-muted">
        המערכת בבנייה. פועלים: כניסה והרשאות, סנכרון מחשבשבת, לקוחות והסכמי מחיר, פניות ומעקב, הצעות מחיר ואישורן. הזמנות ושינויים בהן, הזמנות קבועות, תוכנית ייצור. הבאים בתור: יציאה לשילוח ותעודת משלוח.
        {s.customers === 0 ? " עדיין לא נטענו לקוחות: יש להריץ סנכרון במסך הלקוחות." : ""}
      </p>
    </div>
  );
}

function Tile({ value, label, note, href, id }: { value: number; label: string; note?: string; href?: string; id: string }) {
  const body = (
    <>
      <b className="block font-display text-3xl tabular-nums">{value.toLocaleString("he-IL")}</b>
      <span className="text-sm text-muted">{label}</span>
      {note ? <span className="block text-sm">{note}</span> : null}
    </>
  );
  const cls = "rounded-xl border border-line bg-surface p-3";
  return href ? (
    <Link id={id} href={href} className={`${cls} hover:border-accent`}>
      {body}
    </Link>
  ) : (
    <div id={id} className={cls}>
      {body}
    </div>
  );
}
