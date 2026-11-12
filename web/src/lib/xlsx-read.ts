// A small reader for .xlsx files: the first sheet as a grid of text cells. No dependency beyond Node's zlib.
// It reads what the Milgam files need (text, numbers, shared and inline strings) and nothing else:
// no formulas are evaluated, no styles are read. Dates are returned as the numbers Excel stores.
import { inflateRawSync } from "node:zlib";

export class XlsxError extends Error {}

const MAX_FILE = 5 * 1024 * 1024;
const MAX_UNPACKED = 40 * 1024 * 1024;

/** The files inside a zip archive, by name. Only what was asked for is unpacked. */
function unzip(buf: Buffer, wanted: (name: string) => boolean): Map<string, string> {
  // The directory of a zip sits at its end; its last record says where the directory starts.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new XlsxError("הקובץ אינו קובץ אקסל (xlsx).");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  let unpacked = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new XlsxError("קובץ האקסל פגום.");
    const method = buf.readUInt16LE(at + 10);
    const packedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;
    unpacked += size;
    if (unpacked > MAX_UNPACKED) throw new XlsxError("קובץ האקסל גדול מדי.");
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new XlsxError("קובץ האקסל פגום.");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const packed = buf.subarray(start, start + packedSize);
    let data: Buffer;
    if (method === 0) data = packed;
    else if (method === 8) {
      try {
        data = inflateRawSync(packed, { maxOutputLength: MAX_UNPACKED });
      } catch {
        throw new XlsxError("קובץ האקסל פגום.");
      }
    } else throw new XlsxError("קובץ האקסל דחוס בשיטה שאינה נתמכת.");
    out.set(name, data.toString("utf8"));
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m))).replace(/_x000D_/g, "\r");
/** The text of an <si> or <is> element: its <t> pieces, without phonetic hints. */
const textOf = (xml: string) => [...xml.replace(/<rPh[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join("");

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** The first sheet of the workbook as rows of text. Empty cells are "". Rows are as long as the widest row. */
export function readXlsx(input: Uint8Array): string[][] {
  if (input.length > MAX_FILE) throw new XlsxError("הקובץ גדול מדי (עד 5MB).");
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new XlsxError("הקובץ אינו קובץ אקסל (xlsx).");
  const files = unzip(buf, (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const sheetName = [...files.keys()].filter((n) => n.startsWith("xl/worksheets/")).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))[0];
  if (!sheetName) throw new XlsxError("לא נמצא גיליון בקובץ.");
  const shared = [...(files.get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => textOf(m[1] ?? ""));
  const rows: string[][] = [];
  let width = 0;
  for (const rowMatch of files.get(sheetName)!.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const r = Number(rowMatch[1].match(/\br="(\d+)"/)?.[1] ?? rows.length + 1) - 1;
    if (r > 20000) throw new XlsxError("בגיליון יותר מדי שורות.");
    const row: string[] = [];
    let next = 0;
    for (const c of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = c[1].match(/\br="([A-Z]+)\d+"/)?.[1];
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      if (col > 1000) throw new XlsxError("בגיליון יותר מדי עמודות.");
      const type = c[1].match(/\bt="(\w+)"/)?.[1];
      const body = c[2] ?? "";
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = "";
      if (type === "s") value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = textOf(body);
      else if (v !== undefined) value = decode(v);
      row[col] = value;
    }
    rows[r] = row;
    width = Math.max(width, row.length);
  }
  return Array.from(rows, (row) => Array.from({ length: width }, (_, i) => row?.[i] ?? ""));
}
