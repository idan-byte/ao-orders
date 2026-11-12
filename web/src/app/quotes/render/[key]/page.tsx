import { Suspense } from "react";
import { connection } from "next/server";
import { loadQuoteDoc } from "@/lib/quotes-data";
import { takeRenderKey } from "@/lib/quote-pdf";
import { QuoteDocument } from "@/components/quote-document";

// Opened only by the server's own headless browser while it prints a quote to PDF.
// The key in the address is random and exists only while the file is being made, so this page needs no login.
export default function RenderPage({ params }: PageProps<"/quotes/render/[key]">) {
  return (
    <Suspense fallback={null}>
      <Render params={params} />
    </Suspense>
  );
}

async function Render({ params }: { params: PageProps<"/quotes/render/[key]">["params"] }) {
  await connection();
  const { key } = await params;
  const versionId = takeRenderKey(key);
  const doc = versionId ? await loadQuoteDoc(versionId) : null;
  if (!doc) return <p>הקישור אינו בתוקף.</p>;
  return <QuoteDocument doc={doc} />;
}
