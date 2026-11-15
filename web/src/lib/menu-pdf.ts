// Reads the positioned text and the table lines of a PDF, for the menu builder in menu-parse-core.
import type { PdfPage } from "./menu-parse-core.ts";

export class PdfReadError extends Error {}

export async function readPdfPages(bytes: Uint8Array): Promise<PdfPage[]> {
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let doc;
  try {
    doc = await getDocument({ data: bytes, useSystemFonts: true, verbosity: 0 }).promise;
  } catch {
    throw new PdfReadError("הקובץ אינו PDF תקין.");
  }
  if (doc.numPages > 20) throw new PdfReadError("בקובץ יותר מ-20 עמודים; זה לא נראה כמו מסמך תפריט.");
  const pages: PdfPage[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const texts: PdfPage["texts"] = [];
    for (const it of content.items) {
      if (!("str" in it) || it.str.trim() === "") continue;
      texts.push({ x: it.transform[4], y: it.transform[5], w: it.width, str: it.str, ltr: it.dir === "ltr" });
    }
    // The borders of a table are drawn as thin, long shapes: their bounding boxes give the grid.
    const ops = await page.getOperatorList();
    const h: PdfPage["h"] = [], v: PdfPage["v"] = [];
    // Some programs (a browser's "print to PDF") draw in their own scale, so the drawing matrix is followed
    // and every box is brought back to the page's coordinates, where the text is.
    let m = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn === OPS.save) stack.push(m);
      else if (fn === OPS.restore) m = stack.pop() ?? m;
      else if (fn === OPS.transform) {
        const [a, b, c, d, e, f] = ops.argsArray[i] as number[];
        m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
      }
      if (fn !== OPS.constructPath) continue;
      const box = ops.argsArray[i]?.[2] as ArrayLike<number> | undefined;
      if (!box || box.length < 4) continue;
      const xs = [m[0] * box[0] + m[2] * box[1] + m[4], m[0] * box[2] + m[2] * box[3] + m[4]];
      const ys = [m[1] * box[0] + m[3] * box[1] + m[5], m[1] * box[2] + m[3] * box[3] + m[5]];
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const w = x1 - x0, height = y1 - y0;
      if (height < 2.5 && w > 15) h.push({ y: (y0 + y1) / 2, len: w });
      else if (w < 2.5 && height > 5) v.push({ x: (x0 + x1) / 2, len: height });
    }
    // Borders drawn piece by piece (one per cell) add up to the full line.
    const sum = <K extends "x" | "y">(list: ({ len: number } & Record<K, number>)[], key: K) => {
      const by = new Map<number, number>();
      for (const l of list) by.set(Math.round(l[key]), (by.get(Math.round(l[key])) ?? 0) + l.len);
      return [...by].map(([pos, len]) => ({ [key]: pos, len }) as { len: number } & Record<K, number>);
    };
    pages.push({ texts, h: sum(h, "y"), v: sum(v, "x") });
  }
  return pages;
}
