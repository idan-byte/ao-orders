import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { CHANNEL_KINDS, formatPhone, getOutgoing, listChannels, type Channel } from "@/lib/comm-core";
import { mailConfigured } from "@/lib/mail";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { addChannelAction, channelCommandAction, outgoingAction } from "./actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const note = "rounded-lg bg-sunken px-3 py-2 text-sm";

export default function CommunicationPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Content />
    </Suspense>
  );
}

function ChannelRow({ c }: { c: Channel }) {
  return (
    <li data-channel={c.address} data-kind={c.kind} data-active={c.active} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
      <div className="min-w-0">
        <span dir="ltr" className="font-medium">
          {c.kind === "whatsapp" ? formatPhone(c.address) : c.address}
        </span>
        {c.label ? <span className="text-muted"> · {c.label}</span> : null}
        <span className="text-sm text-muted">
          {" · "}
          {c.active ? "פעיל" : <b className="text-foreground">לא בשימוש</b>}
          {c.leads > 0 ? ` · ${c.leads} פניות` : ""}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <ActionForm action={channelCommandAction} submit={c.active ? "הפסק להשתמש" : "החזר לשימוש"} primary={false}>
          <input type="hidden" name="channel_id" value={c.id} />
          <input type="hidden" name="command" value={c.active ? "deactivate" : "activate"} />
        </ActionForm>
        {c.leads === 0 ? (
          <ActionForm action={channelCommandAction} submit="מחק" primary={false}>
            <input type="hidden" name="channel_id" value={c.id} />
            <input type="hidden" name="command" value="remove" />
          </ActionForm>
        ) : null}
      </div>
    </li>
  );
}

async function Content() {
  const { allowed } = await requirePermission("settings.manage");
  if (!allowed) return <NoAccess />;
  const channels = await listChannels(query);
  const outgoing = await getOutgoing(query);
  const smtpUser = process.env.SMTP_USER || null;
  const serverDefault = process.env.MAIL_FROM || smtpUser;
  const live = mailConfigured();
  const differs = !!outgoing.email && !!smtpUser && outgoing.email !== smtpUser.toLowerCase();

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">ניהול תקשורת</h1>

      <section className={panel} id="incoming">
        <h2 className="font-display text-lg font-bold">מקורות נכנסים</h2>
        <p className="mt-1 text-sm text-muted">כתובות המייל ומספרי הווטסאפ שאליהם מגיעות פניות של לקוחות. אלה המקורות של תיבת הלידים והצעות המחיר.</p>
        <p className={`${note} mt-3`} id="incoming-status">
          <b>מה עובד היום:</b> כשפותחים פנייה במסך המכירות בוחרים לאיזה מקור היא הגיעה, והמקור נשמר על הפנייה. <b>קליטה אוטומטית</b> של מיילים והודעות ווטסאפ ישר לתיבת הלידים עוד לא מחוברת.
        </p>
        {(["email", "whatsapp"] as const).map((kind) => {
          const list = channels.filter((c) => c.kind === kind);
          return (
            <div key={kind} className="mt-4" data-kind-list={kind}>
              <h3 className="mb-2 font-medium">
                {kind === "email" ? "כתובות מייל" : "מספרי ווטסאפ"} · {list.length}
              </h3>
              {list.length === 0 ? (
                <p className="text-sm text-muted">{kind === "email" ? "עוד לא הוגדרה כתובת מייל." : "עוד לא הוגדר מספר ווטסאפ."}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {list.map((c) => (
                    <ChannelRow key={c.id} c={c} />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        <div className="mt-4 border-t border-line pt-4" id="new-channel">
          <ActionForm action={addChannelAction} submit="הוסף מקור" pendingLabel="מוסיף…">
            <label className={label}>
              סוג
              <select name="kind" defaultValue="email" className={field}>
                {Object.entries(CHANNEL_KINDS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              כתובת מייל או מספר טלפון
              <input name="address" required dir="ltr" maxLength={254} className={`${field} w-64 max-w-full`} />
            </label>
            <label className={`${label} min-w-0 flex-1`}>
              למה הוא משמש (לא חובה)
              <input name="label" maxLength={80} placeholder="למשל: מגשי אירוח" className={field} />
            </label>
          </ActionForm>
        </div>
      </section>

      <section className={panel} id="outgoing">
        <h2 className="font-display text-lg font-bold">שולח המסמכים</h2>
        <p className="mt-1 text-sm text-muted">הזהות שבשמה נשלח כל מסמך ללקוח: הצעת מחיר היום, ובהמשך גם אישור הזמנה ותעודת משלוח.</p>
        <div className="mt-3">
          <ActionForm action={outgoingAction} submit="שמור" className="flex flex-wrap items-end gap-3">
            <label className={label}>
              כתובת המייל השולחת
              <input name="email" type="email" dir="ltr" defaultValue={outgoing.email ?? ""} placeholder={serverDefault ?? ""} maxLength={254} className={`${field} w-64 max-w-full`} />
            </label>
            <label className={label}>
              השם שהלקוח רואה
              <input name="email_name" defaultValue={outgoing.emailName ?? ""} maxLength={60} placeholder="למשל: אבי ועופר שירותי מזון" className={`${field} w-64 max-w-full`} />
            </label>
            <label className={label}>
              חשבון הווטסאפ השולח
              <input name="whatsapp" type="tel" dir="ltr" defaultValue={outgoing.whatsapp ? formatPhone(outgoing.whatsapp) : ""} className={`${field} w-44`} />
            </label>
          </ActionForm>
        </div>
        <div className="mt-3 flex flex-col gap-2" id="outgoing-status">
          <p className={note} data-status="email">
            <b>מייל:</b>{" "}
            {outgoing.email ? (
              <>
                מסמכים יוצאים בשם <span dir="ltr">{outgoing.email}</span>, ותשובת הלקוח חוזרת לכתובת הזו.
              </>
            ) : serverDefault ? (
              <>
                לא נבחרה כתובת, ולכן מסמכים יוצאים בשם ברירת המחדל של השרת, <span dir="ltr">{serverDefault}</span>.
              </>
            ) : (
              "לא נבחרה כתובת שולחת."
            )}{" "}
            {live ? (
              <>
                השליחה עצמה נעשית דרך חשבון הדואר <span dir="ltr">{smtpUser ?? process.env.SMTP_HOST}</span>.
              </>
            ) : (
              "שרת הדואר לא מוגדר במחשב הזה, ולכן מיילים נשמרים בתיקייה ולא נשלחים."
            )}
            {differs && live ? " כדי שהלקוח יראה את הכתובת שנבחרה כשולחת, היא צריכה להיות מוגדרת בחשבון הדואר ככתובת ״שליחה בשם״. בלי זה Gmail מציג את כתובת החשבון עצמו." : ""}
          </p>
          <p className={note} data-status="whatsapp">
            <b>ווטסאפ:</b> {outgoing.whatsapp ? <>החשבון שנבחר הוא <span dir="ltr">{formatPhone(outgoing.whatsapp)}</span>. </> : "לא נבחר חשבון. "}
            שליחת מסמכים בווטסאפ עוד לא מחוברת. היא דורשת חשבון WhatsApp Business דרך ספק מורשה, והמספר שנשמר כאן ישמש אותה כשתחובר.
          </p>
        </div>
      </section>
    </div>
  );
}
