import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { loadQuoteDoc } from "@/lib/quotes-data";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { QuoteDocument } from "@/components/quote-document";
import { PrintButton } from "@/components/print-button";

export default function QuotePrintPage({ params, searchParams }: PageProps<"/quotes/[id]/print">) {
  return (
    <Suspense fallback={<Loading />}>
      <PrintContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function PrintContent({ params, searchParams }: Pick<PageProps<"/quotes/[id]/print">, "params" | "searchParams">) {
  const { allowed } = await requirePermission("quotes.view");
  if (!allowed) return <NoAccess />;
  const { id } = await params;
  const version = Number((await searchParams).v);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(version)) return <p>הגרסה לא נמצאה.</p>;
  const [v] = await query<{ id: string }>("select id::text from quote_versions where quote_id = $1 and version = $2", [id, version]);
  const doc = v ? await loadQuoteDoc(v.id) : null;
  if (!doc) return <p>הגרסה לא נמצאה.</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="no-print flex flex-wrap items-center gap-3">
        <PrintButton />
        <a id="quote-print-pdf" href={`/quotes/${id}/pdf?v=${version}`} className="rounded-lg border border-line px-4 py-2">
          הורד PDF
        </a>
        <Link href={`/quotes/${id}`} className="rounded-lg border border-line px-4 py-2">
          חזרה להצעה
        </Link>
      </div>
      <QuoteDocument doc={doc} />
    </div>
  );
}
