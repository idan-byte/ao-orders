import { printPage } from "./pdf-render";

// A quote as a PDF file: the same page the customer sees, printed on the server (see pdf-render.ts).
export { internalOrigin, takeRenderKey } from "./pdf-render";

export function renderQuotePdf(versionId: string, origin: string): Promise<Buffer> {
  return printPage({ path: (key) => `/quotes/render/${key}`, payload: versionId, origin, ready: "article.quote-doc" });
}
