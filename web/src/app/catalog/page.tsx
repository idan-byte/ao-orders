import { Suspense } from "react";
import { query } from "@/lib/db";
import { Loading } from "@/components/loading";

type ProductRow = {
  sku: string;
  name: string;
  base_price: string;
  department: string | null;
  default_shift: number | null;
  variants: number;
};

const SHIFTS = ["ערב קודם", "לילה", "בוקר"];
const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS" });

export default function CatalogPage() {
  return (
    <Suspense fallback={<Loading />}>
      <CatalogContent />
    </Suspense>
  );
}

async function CatalogContent() {
  const rows = await query<ProductRow>(`
    select p.sku, p.name, p.base_price::text, d.name as department, o.default_shift,
           (select count(*)::int from product_variants v where v.sku = p.sku and v.active) as variants
    from products p
    left join product_ops o on o.sku = p.sku
    left join departments d on d.id = o.department_id
    order by d.name nulls last, p.name`);

  const groups = new Map<string, ProductRow[]>();
  for (const r of rows) {
    const key = r.department ?? "שירותים (ללא ייצור)";
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">קטלוג</h1>
        <span className="rounded-lg bg-sunken px-3 py-1.5 text-sm text-muted">
          {rows.length} מוצרים שנמכרו ב-12 החודשים האחרונים · מק״ט, שם ומחיר בסיס מחשבשבת
        </span>
      </div>
      {[...groups.entries()].map(([dept, items]) => (
        <section key={dept} className="rounded-xl border border-line bg-surface p-4">
          <h2 className="mb-2 font-display text-base font-bold">
            {dept} <span className="font-sans text-sm font-normal text-muted">· {items.length}</span>
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse tabular-nums">
              <thead>
                <tr className="border-b border-line text-start text-xs text-muted">
                  <th className="px-2 py-1.5 text-start font-medium">מק״ט</th>
                  <th className="px-2 py-1.5 text-start font-medium">מוצר</th>
                  <th className="px-2 py-1.5 text-start font-medium">משמרת</th>
                  <th className="px-2 py-1.5 text-start font-medium">סוגים</th>
                  <th className="px-2 py-1.5 text-end font-medium">מחיר בסיס לפני מע״מ</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.sku} className="border-b border-line last:border-0">
                    <td className="px-2 py-2">{r.sku}</td>
                    <td className="px-2 py-2">{r.name}</td>
                    <td className="px-2 py-2">{r.department && r.default_shift !== null ? SHIFTS[r.default_shift] : ""}</td>
                    <td className="px-2 py-2">{r.variants || <span className="text-muted">טרם הוגדרו</span>}</td>
                    <td className="px-2 py-2 text-end">
                      {Number(r.base_price) > 0 ? money.format(Number(r.base_price)) : <span className="text-muted">לא מוגדר</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
