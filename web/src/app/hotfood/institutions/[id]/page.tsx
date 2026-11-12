import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { getInstitution } from "@/lib/hotfood-core";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { linkInstitutionAction } from "../../actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const small = "rounded-lg border border-line px-3 py-1.5 text-sm";

// One institution: Milgam's details, and the two things a person decides: who is billed and where it is delivered.
export default function InstitutionPage({ params }: PageProps<"/hotfood/institutions/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Institution params={params} />
    </Suspense>
  );
}

async function Institution({ params }: Pick<PageProps<"/hotfood/institutions/[id]">, "params">) {
  const { user, allowed } = await requirePermission("hotfood.view");
  if (!allowed) return <NoAccess />;
  const { id } = await params;
  const inst = /^\d{1,9}$/.test(id) ? await getInstitution(query, Number(id)) : null;
  if (!inst) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="font-display text-2xl font-bold">המוסד לא נמצא</h1>
        <Link href="/hotfood/institutions" className={small}>
          חזרה לרשימת המוסדות
        </Link>
      </div>
    );
  }
  const manage = can(user.role, "hotfood.manage");
  const customers = manage ? await query<{ id: string; name: string }>("select id::text, name from customers where active or id = $1 order by name", [inst.customerId]) : [];
  const addresses = inst.customerId
    ? await query<{ id: string; text: string; route: string | null }>(
        "select a.id::text, concat_ws(', ', a.label, a.street, a.city) as text, r.name as route from customer_addresses a left join routes r on r.id = a.route_id where a.customer_id = $1 order by a.is_default desc, a.street",
        [inst.customerId],
      )
    : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">
          {inst.name} <span className="text-lg font-normal text-muted">· סמל {inst.symbol}</span>
        </h1>
        <Link href="/hotfood/institutions" className={small}>
          כל המוסדות
        </Link>
      </div>

      <section className={`${panel} ${inst.lifeThreatening ? "border-2 border-[#b42318]" : ""}`} id="institution-details">
        <p className="text-muted">{[inst.kind, inst.authority, inst.kosher].filter(Boolean).join(" · ")}</p>
        <p>כתובת לפי מילגם: {inst.address ?? "אין בקובץ"}</p>
        {inst.lifeThreatening ? <p className="mt-2 font-bold text-[#b42318]">אלרגיות מסכנות חיים</p> : null}
        {inst.notes ? (
          <p className="mt-1 whitespace-pre-line font-bold" data-notes>
            {inst.notes}
          </p>
        ) : null}
        <p className="mt-3 text-sm text-muted">
          {inst.groups.length} מסגרות: {inst.groups.map((g) => g.className).join(", ")}
        </p>
      </section>

      <section className={panel} id="institution-link">
        <h2 className="font-display text-lg font-bold">חיוב ואספקה</h2>
        <p className="mb-3 mt-1 text-sm text-muted">הלקוח שמחויב על המנות של המוסד, וכתובת האספקה שלו. קו החלוקה נקבע לפי הכתובת, במסך הקווים. בלי שניהם אי אפשר ליצור למוסד אספקה.</p>
        {manage ? (
          <div className="flex flex-col gap-4">
            <ActionForm action={linkInstitutionAction} submit="שמור לקוח">
              <input type="hidden" name="institution_id" value={inst.id} />
              <label className={label}>
                לקוח לחיוב
                <select name="customer_id" defaultValue={inst.customerId ?? ""} className={`${field} max-w-80`}>
                  <option value="">לא שויך</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <span className="pb-2 text-sm text-muted">החלפת לקוח מנקה את הכתובת שנבחרה.</span>
            </ActionForm>
            {inst.customerId ? (
              addresses.length === 0 ? (
                <p className="text-sm">
                  ללקוח הזה אין כתובות אספקה. מוסיפים כתובת ב
                  <Link href={`/customers/${inst.customerId}`} className="underline">
                    כרטיס הלקוח
                  </Link>
                  .
                </p>
              ) : (
                <ActionForm action={linkInstitutionAction} submit="שמור כתובת">
                  <input type="hidden" name="institution_id" value={inst.id} />
                  <input type="hidden" name="customer_id" value={inst.customerId} />
                  <label className={label}>
                    כתובת אספקה
                    <select name="address_id" defaultValue={inst.addressId ?? ""} className={`${field} max-w-96`}>
                      <option value="">לא נבחרה</option>
                      {addresses.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.text}
                          {a.route ? ` · קו ${a.route}` : " · בלי קו"}
                        </option>
                      ))}
                    </select>
                  </label>
                </ActionForm>
              )
            ) : null}
          </div>
        ) : null}
        <p className="mt-3" id="link-status" data-linked={String(!!inst.customerId && !!inst.addressId)}>
          {inst.customer ? `לקוח: ${inst.customer}` : "עוד לא שויך לקוח."}
          {inst.linkedAddress ? ` · כתובת: ${inst.linkedAddress}` : inst.customer ? " · עוד לא נבחרה כתובת." : ""}
          {inst.linkedAddress ? (inst.route ? ` · קו ${inst.route}` : " · הכתובת עוד לא שויכה לקו חלוקה") : ""}
        </p>
      </section>
    </div>
  );
}
