import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { listInstitutions } from "@/lib/milgam-core";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";

const panel = "rounded-xl border border-line bg-surface p-4";

// Institutions as Milgam's files describe them. The allergy remark is shown whole, never shortened.
export default function InstitutionsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Institutions />
    </Suspense>
  );
}

async function Institutions() {
  const { allowed } = await requirePermission("hotfood.view");
  if (!allowed) return <NoAccess />;
  const list = await listInstitutions(query);
  const flagged = list.filter((i) => i.lifeThreatening).length;
  const groups = list.reduce((a, i) => a + i.groups, 0);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">מוסדות</h1>
      <p className="text-muted" id="institutions-summary">
        {list.length} מוסדות · {groups} מסגרות (כיתות) · {flagged} מוסדות עם אלרגיות מסכנות חיים
      </p>
      {list.length === 0 ? (
        <section className={panel}>
          <p>עוד אין מוסדות. הם נוצרים בטעינת קובץ מילגם, כשמסמנים ״להוסיף מוסדות וסוגי מנה חדשים״.</p>
        </section>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((i) => (
            <li key={i.id} data-institution={i.symbol} data-allergy={i.lifeThreatening} className={`${panel} ${i.lifeThreatening ? "border-2 border-[#b42318]" : ""}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-lg font-medium">
                  {i.name} <span className="text-base font-normal text-muted">· סמל {i.symbol}</span>
                </span>
                <span className="text-sm text-muted">
                  {[i.kind, i.authority, i.kosher].filter(Boolean).join(" · ")} · {i.groups} מסגרות
                </span>
              </div>
              <div className="text-muted">{i.address ?? "אין כתובת בקובץ"}</div>
              {i.lifeThreatening ? <div className="mt-2 font-bold text-[#b42318]">אלרגיות מסכנות חיים</div> : null}
              {i.notes ? (
                <p className="mt-1 whitespace-pre-line font-bold" data-notes>
                  {i.notes}
                </p>
              ) : null}
              <div className="mt-2 text-sm text-muted">{i.customer ? `לקוח לחיוב: ${i.customer}` : "עוד לא שויך ללקוח לחיוב ולקו חלוקה."}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
