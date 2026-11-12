import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { SHIFTS } from "@/lib/production-core";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { addVariantAction, toggleVariantAction, updateOpsAction } from "../actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS" });

export default function ProductPage({ params }: PageProps<"/catalog/[sku]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Product params={params} />
    </Suspense>
  );
}

async function Product({ params }: { params: PageProps<"/catalog/[sku]">["params"] }) {
  const { user, allowed } = await requirePermission("catalog.edit");
  if (!allowed) return <NoAccess />;
  const sku = decodeURIComponent((await params).sku);
  const back = (
    <Link href="/catalog" className="rounded-lg border border-line px-3 py-1.5 text-sm">
      חזרה לקטלוג
    </Link>
  );
  const [p] = await query<{ sku: string; name: string; base_price: number; orderable: boolean | null; department_id: number | null; default_shift: number | null }>(
    "select p.sku, p.name, p.base_price::float, o.orderable, o.department_id, o.default_shift from products p left join product_ops o on o.sku = p.sku where p.sku = $1",
    [sku],
  );
  if (!p) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="font-display text-2xl font-bold">המוצר לא נמצא</h1>
        {back}
      </div>
    );
  }
  const departments = await query<{ id: number; name: string }>("select id, name from departments order by id");
  const variants = await query<{ id: number; name: string; active: boolean; used: number }>(
    `select v.id, v.name, v.active,
            ((select count(*) from delivery_lines l where l.variant_id = v.id) + (select count(*) from standing_order_lines s where s.variant_id = v.id))::int as used
     from product_variants v where v.sku = $1 order by v.active desc, v.name`,
    [sku],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">
          {p.name}{" "}
          <span className="font-sans text-base font-normal text-muted" dir="ltr">
            {p.sku}
          </span>
        </h1>
        {back}
      </div>
      <p className="rounded-lg bg-sunken px-3 py-2 text-sm">
        מק״ט, שם{can(user.role, "prices.view") ? ` ומחיר בסיס (${p.base_price > 0 ? money.format(p.base_price) : "לא מוגדר"})` : ""} מגיעים מחשבשבת ומתעדכנים שם. כאן מגדירים רק את מה שחשבשבת אינה מחזיקה: ייצור וסוגים.
      </p>

      <section className={panel}>
        <h2 className="mb-3 font-display text-base font-bold">הזמנה וייצור</h2>
        <ActionForm action={updateOpsAction} submit="שמור">
          <input type="hidden" name="sku" value={p.sku} />
          <label className={label}>
            מחלקה מייצרת
            <select id="ops-department" name="department_id" defaultValue={p.department_id ?? ""} className={field}>
              <option value="">שירות (ללא ייצור)</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            משמרת ברירת מחדל
            <select id="ops-shift" name="default_shift" defaultValue={p.default_shift ?? 2} className={field}>
              {SHIFTS.map((name, i) => (
                <option key={i} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 py-2">
            <input id="ops-orderable" type="checkbox" name="orderable" defaultChecked={p.orderable ?? false} className="size-5" />
            אפשר להזמין את המוצר
          </label>
        </ActionForm>
      </section>

      <section className={panel}>
        <h2 className="mb-1 font-display text-base font-bold">סוגים (מילויים, סוגי מנות)</h2>
        <p className="mb-3 text-sm text-muted">
          לחשבשבת עובר רק המק״ט. הסוג משמש את ההזמנה ואת דוח הייצור. כשלמוצר יש סוג פעיל אחד לפחות, חובה לבחור סוג בכל שורה חדשה בהצעה, בהזמנה ובהזמנה קבועה.
        </p>
        {variants.length > 0 ? (
          <ul className="mb-4 flex flex-col gap-1.5" data-variants>
            {variants.map((v) => (
              <li key={v.id} data-variant={v.name} data-active={String(v.active)} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
                <span className={v.active ? "" : "text-muted"}>
                  {v.name}
                  <span className="text-sm text-muted">
                    {" "}
                    · {v.active ? "פעיל" : "לא פעיל"}
                    {v.used > 0 ? ` · מופיע ב-${v.used} שורות` : ""}
                  </span>
                </span>
                <form action={toggleVariantAction}>
                  <input type="hidden" name="sku" value={p.sku} />
                  <input type="hidden" name="variant_id" value={v.id} />
                  <input type="hidden" name="active" value={String(!v.active)} />
                  <button className="rounded-lg border border-line px-3 py-1.5 text-sm">{v.active ? "הפסק להציע" : "החזר לשימוש"}</button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-4 text-muted">עדיין לא הוגדרו סוגים. המוצר מוזמן ומיוצר כפריט אחד.</p>
        )}
        <ActionForm action={addVariantAction} submit="הוסף סוג" primary={false}>
          <input type="hidden" name="sku" value={p.sku} />
          <label className={label}>
            שם הסוג
            <input id="variant-name" name="name" maxLength={40} placeholder="למשל: טונה" className={field} />
          </label>
        </ActionForm>
        <p className="mt-3 text-sm text-muted">סוג אינו נמחק, כי הזמנות קודמות מפנות אליו. ״הפסק להציע״ מסיר אותו מהזמנות חדשות בלבד.</p>
      </section>
    </div>
  );
}
