import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { listLetterheads } from "@/lib/letterheads-core";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { letterheadCommandAction, saveLetterheadAction, uploadLogoAction } from "./actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";

export default function LetterheadsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Letterheads />
    </Suspense>
  );
}

function Fields({ l }: { l?: { name: string; title: string; subtitle: string | null; footer: string | null } }) {
  return (
    <>
      <label className={label}>
        שם לבחירה (פנימי)
        <input name="name" required maxLength={40} defaultValue={l?.name ?? ""} placeholder="למשל: מגשי אירוח" className={field} />
      </label>
      <label className={label}>
        שם העסק במסמך
        <input name="title" required defaultValue={l?.title ?? ""} className={`${field} w-72`} />
      </label>
      <label className={label}>
        שורת פרטים מתחת ללוגו
        <input name="subtitle" defaultValue={l?.subtitle ?? ""} placeholder="כתובת, טלפון, ח.פ." className={`${field} w-80`} />
      </label>
      <label className={label}>
        שורה בתחתית המסמך
        <input name="footer" defaultValue={l?.footer ?? ""} className={`${field} w-80`} />
      </label>
    </>
  );
}

async function Letterheads() {
  const { allowed } = await requirePermission("settings.manage");
  if (!allowed) return <NoAccess />;
  const list = await listLetterheads(query);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">דפי לוגו</h1>
        <Link href="/quotes" className="rounded-lg border border-line px-3 py-1.5 text-sm">
          חזרה להצעות המחיר
        </Link>
      </div>
      <p className="rounded-lg bg-sunken px-3 py-2 text-sm">
        דף לוגו הוא הכותרת שמסמך ללקוח מודפס תחתיה. לכל תחום פעילות אפשר להגדיר דף משלו, ובכל הצעת מחיר בוחרים באיזה דף להשתמש. הצעה שלא נבחר לה דף משתמשת בברירת המחדל.
      </p>

      {list.map((l) => (
        <section key={l.id} className={panel} data-letterhead={l.name} data-default={String(l.isDefault)} data-active={String(l.active)}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-base font-bold">
              {l.name}
              <span className="font-sans text-sm font-normal text-muted">
                {l.isDefault ? " · ברירת מחדל" : ""}
                {!l.active ? " · לא בשימוש" : ""}
                {l.quotes > 0 ? ` · נבחר ב-${l.quotes} הצעות` : ""}
              </span>
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              {!l.isDefault && l.active ? (
                <ActionForm action={letterheadCommandAction} submit="קבע כברירת מחדל" primary={false}>
                  <input type="hidden" name="letterhead_id" value={l.id} />
                  <input type="hidden" name="command" value="default" />
                </ActionForm>
              ) : null}
              {!l.isDefault ? (
                <ActionForm action={letterheadCommandAction} submit={l.active ? "הפסק להציע" : "החזר לשימוש"} primary={false}>
                  <input type="hidden" name="letterhead_id" value={l.id} />
                  <input type="hidden" name="command" value={l.active ? "deactivate" : "activate"} />
                </ActionForm>
              ) : null}
            </div>
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-4 rounded-lg border border-line p-3">
            {l.hasLogo ? (
              // eslint-disable-next-line @next/next/no-img-element -- the logo is served from the database, not from static files
              <img data-logo src={`/letterheads/${l.id}/logo?v=${l.logoVersion}`} alt={l.title} className="max-h-20 max-w-64 object-contain" />
            ) : (
              <span className="font-display text-xl font-bold">{l.title}</span>
            )}
            <span className="text-sm text-muted">{l.hasLogo ? "כך הלוגו יופיע בראש המסמך." : "אין תמונת לוגו. בראש המסמך יופיע שם העסק ככתוב."}</span>
          </div>

          <div className="flex flex-col gap-4">
            <ActionForm action={uploadLogoAction} submit={l.hasLogo ? "החלף לוגו" : "העלה לוגו"} pendingLabel="מעלה…" primary={false}>
              <input type="hidden" name="letterhead_id" value={l.id} />
              <label className={label}>
                תמונת לוגו (PNG, JPG או WebP, עד 1MB)
                <input name="logo" type="file" accept="image/png,image/jpeg,image/webp" required className={field} />
              </label>
            </ActionForm>
            {l.hasLogo ? (
              <ActionForm action={letterheadCommandAction} submit="הסר לוגו" primary={false}>
                <input type="hidden" name="letterhead_id" value={l.id} />
                <input type="hidden" name="command" value="remove_logo" />
              </ActionForm>
            ) : null}
            <ActionForm action={saveLetterheadAction} submit="שמור פרטים" primary={false}>
              <input type="hidden" name="letterhead_id" value={l.id} />
              <Fields l={l} />
            </ActionForm>
          </div>
        </section>
      ))}

      <section className={panel} id="new-letterhead">
        <h2 className="mb-3 font-display text-base font-bold">דף לוגו חדש</h2>
        <ActionForm action={saveLetterheadAction} submit="הוסף דף לוגו">
          <Fields />
        </ActionForm>
      </section>
    </div>
  );
}
