import { Suspense } from "react";
import { query } from "@/lib/db";
import { findByToken } from "@/lib/quotes-core";
import { loadQuoteDoc } from "@/lib/quotes-data";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { QuoteDocument } from "@/components/quote-document";
import { approveByLinkAction } from "@/app/quotes/actions";

// Public page: the customer opens it from the link they received. No login.
// It shows one version of one quote and nothing else about the customer or the system.

export default function PublicQuotePage({ params }: PageProps<"/q/[token]">) {
  return (
    <Suspense fallback={<Loading />}>
      <PublicQuote params={params} />
    </Suspense>
  );
}

async function PublicQuote({ params }: { params: PageProps<"/q/[token]">["params"] }) {
  const { token } = await params;
  const found = await findByToken(query, token);
  const doc = found ? await loadQuoteDoc(found.versionId) : null;
  if (!doc) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-2 pt-8">
        <h1 className="font-display text-2xl font-bold">הקישור אינו בתוקף</h1>
        <p className="text-muted">ייתכן שההצעה עודכנה או נסגרה. אפשר לפנות אלינו ונשלח קישור מעודכן.</p>
      </div>
    );
  }
  const approved = doc.status === "approved" && !!doc.approvedAt;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <QuoteDocument doc={doc} />
      <section className="rounded-xl border border-line bg-surface p-4">
        {approved ? (
          <p id="public-approved" className="font-medium">
            ההצעה אושרה על ידי {doc.approvedByName}. תודה, ההזמנה נקלטה אצלנו.
          </p>
        ) : doc.expired ? (
          <p id="public-expired">תוקף ההצעה פג. אפשר לפנות אלינו ונשלח הצעה מעודכנת.</p>
        ) : (
          <>
            <h2 className="mb-2 font-display text-base font-bold">אישור ההצעה</h2>
            <p className="mb-3 text-sm text-muted">באישור ההצעה תיפתח אצלנו הזמנה לפי הפריטים, הכמויות והמחירים שמופיעים כאן.</p>
            <ActionForm action={approveByLinkAction} submit="אני מאשר/ת את ההצעה" pendingLabel="מאשר…">
              <input type="hidden" name="token" value={token} />
              <label className="flex flex-col gap-1 text-sm text-muted">
                שם מלא
                <input id="public-name" name="name" required minLength={2} autoComplete="name" className="rounded-lg border border-line bg-surface px-3 py-2 text-foreground" />
              </label>
            </ActionForm>
          </>
        )}
      </section>
    </div>
  );
}
