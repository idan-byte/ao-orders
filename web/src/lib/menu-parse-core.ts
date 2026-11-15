// Builds a cyclic menu from the pages of the approved menu document (the PDF Milgam's dietitian signs):
// one table per week, a column per weekday and a row per category. The input is positioned text and the
// table's ruling lines, as read from the PDF; nothing here depends on the PDF library or on Next.js.

export type PdfText = { x: number; y: number; w: number; str: string; ltr: boolean };
export type PdfPage = { texts: PdfText[]; h: { y: number; len: number }[]; v: { x: number; len: number }[] };

export const CELL_CATEGORIES = [
  { key: "main", label: "מנה עיקרית", sku: true },
  { key: "grain", label: "דגנים", sku: false },
  { key: "hot_side", label: "תוספת חמה", sku: false },
  { key: "vegetarian", label: "מנה לצמחונים", sku: true },
  { key: "allergen_free", label: "ללא אלרגנים", sku: true },
  { key: "vegetable", label: "ירק טרי", sku: false },
  { key: "fruit", label: "פרי טרי", sku: false },
  { key: "bread", label: "לחם", sku: false },
  { key: "other", label: "אחר", sku: false },
] as const;
export type CellCategory = (typeof CELL_CATEGORIES)[number]["key"];
export const WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי"] as const;

export type ParsedCell = { category: CellCategory; text: string; sku: string | null };
export type ParsedDay = { weekday: number; note: string | null; cells: ParsedCell[] };
export type ParsedWeek = { weekNo: number; starts: string[]; days: ParsedDay[] };
export type ParsedMenu = { title: string | null; period: string | null; approvedBy: string | null; approvedOn: string | null; weeks: ParsedWeek[]; notes: string | null; warnings: string[] };

export class MenuParseError extends Error {}

const hasAlnum = (s: string) => /[A-Za-z0-9]/.test(s);
/** Hebrew text sometimes comes out of a PDF with its brackets mirrored: ")פולנטה(". */
function fixBrackets(s: string): string {
  const open = s.indexOf("("), close = s.indexOf(")");
  if (open < 0 || close < 0 || close > open) return s;
  return s.replace(/[()]/g, (c) => (c === "(" ? ")" : "("));
}

/** The text of a group of items as lines, top to bottom, each read right to left. */
export function toLines(items: PdfText[]): { y: number; text: string }[] {
  const sorted = [...items].filter((t) => t.str.trim() !== "").sort((a, b) => b.y - a.y);
  const rows: PdfText[][] = [];
  for (const t of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last[0].y - t.y) <= 3.5) last.push(t);
    else rows.push([t]);
  }
  return rows.map((row) => {
    row.sort((a, b) => b.x + b.w - (a.x + a.w));
    // A run of left-to-right pieces (a number, a date, a code) reads left to right inside the right-to-left line.
    const isL = (t: PdfText | undefined) => !!t && t.ltr && hasAlnum(t.str);
    for (let i = 0; i < row.length; i++) {
      if (!isL(row[i])) continue;
      let j = i;
      while (isL(row[j + 1]) || (row[j + 1]?.ltr && /^[/.-:]+$/.test(row[j + 1].str.trim()) && isL(row[j + 2]))) j += isL(row[j + 1]) ? 1 : 2;
      if (j > i) row.splice(i, j - i + 1, ...row.slice(i, j + 1).reverse());
      i = j;
    }
    let text = "";
    for (let i = 0; i < row.length; i++) {
      const t = row[i], p = row[i - 1];
      if (p) {
        const gap = Math.max(p.x, t.x) - Math.min(p.x + p.w, t.x + t.w);
        if (gap > 1.2 && !/\s$/.test(text) && !/^\s/.test(t.str)) text += " ";
      }
      text += fixBrackets(t.str);
    }
    return { y: row[0].y, text: text.replace(/\s+/g, " ").replace(/ ([,:.])/g, "$1").trim() };
  });
}

function rules(lines: { pos: number; len: number }[]): number[] {
  const merged: { pos: number; len: number }[] = [];
  for (const l of [...lines].sort((a, b) => b.pos - a.pos)) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.pos - l.pos) <= 2) last.len = Math.max(last.len, l.len);
    else merged.push({ ...l });
  }
  const longest = Math.max(0, ...merged.map((l) => l.len));
  return merged.filter((l) => l.len >= longest * 0.6).map((l) => l.pos);
}

function categoryOf(label: string): CellCategory | "sku" {
  if (label.includes("מק")) return "sku";
  if (label.includes("צמחונ")) return "vegetarian";
  if (label.includes("אלרג")) return "allergen_free";
  if (label.includes("עיקרי")) return "main";
  if (label.includes("דגנ") || label.includes("פחמימ")) return "grain";
  if (label.includes("תוספת")) return "hot_side";
  if (label.includes("ירק")) return "vegetable";
  if (label.includes("פרי")) return "fruit";
  if (label.includes("לחם")) return "bread";
  return "other";
}

const isoDate = (d: string, m: string, y: string) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
function validDate(iso: string): boolean {
  const t = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso;
}
/** The Sunday of the week a date is in. */
export function sundayOf(iso: string): string {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - t.getUTCDay());
  return t.toISOString().slice(0, 10);
}

export function buildMenu(pages: PdfPage[]): ParsedMenu {
  const out: ParsedMenu = { title: null, period: null, approvedBy: null, approvedOn: null, weeks: [], notes: null, warnings: [] };
  const notes: string[] = [];
  const heading = new Set<string>();

  const approval = (text: string) => {
    const by = /התזונאית\s*:?\s*(.+?)\s*בתאריך/.exec(text);
    const on = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
    if (by && !out.approvedBy) out.approvedBy = by[1].trim();
    if (on && !out.approvedOn && validDate(isoDate(on[1], on[2], on[3]))) out.approvedOn = isoDate(on[1], on[2], on[3]);
  };

  pages.forEach((page, pageIndex) => {
    const ys = rules(page.h.map((l) => ({ pos: l.y, len: l.len })));
    const xs = rules(page.v.map((l) => ({ pos: l.x, len: l.len })));
    const grid = ys.length >= 3 && xs.length >= 3;
    const top = grid ? ys[0] : -Infinity, bottom = grid ? ys[ys.length - 1] : Infinity;
    const inTable = (t: PdfText) => grid && t.y + 3 < top && t.y + 3 > bottom && t.x + t.w / 2 < xs[0] && t.x + t.w / 2 > xs[xs.length - 1];
    const outside = toLines(page.texts.filter((t) => !inTable(t)));

    // What is written around the table: the heading, the week and its dates, the approval, remarks.
    let weekNo: number | null = null;
    const starts: string[] = [];
    const loose: string[] = [];
    for (const line of outside) {
      const text = line.text;
      if (text.includes("אושר על ידי")) { approval(text); continue; }
      const week = /^שבוע\s*(\d)$/.exec(text);
      if (week && line.y > top) { weekNo = Number(week[1]); continue; }
      const ranges = [...text.matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/g)];
      if (ranges.length > 0 && line.y > top) {
        for (const r of ranges) {
          const from = isoDate(r[1], r[2], r[3]);
          if (!validDate(from)) { out.warnings.push(`תאריך לא תקין בכותרת השבוע: ${r[0]}`); continue; }
          if (sundayOf(from) !== from) out.warnings.push(`טווח התאריכים ${r[0]} אינו מתחיל ביום ראשון; השבוע נקבע לפי יום ראשון שלפניו.`);
          starts.push(sundayOf(from));
        }
        continue;
      }
      loose.push(text);
    }
    // The first two loose lines at the top of every page are the document's heading; they repeat on every page.
    const head = outside.filter((l) => loose.includes(l.text) && l.y > (grid ? top : -Infinity)).slice(0, 2).map((l) => l.text);
    if (pageIndex === 0) {
      out.title = head[0] ?? null;
      out.period = head[1] ?? null;
      head.forEach((h) => heading.add(h));
    }
    const remarks = loose.filter((l) => !heading.has(l));

    if (!grid) {
      notes.push(...remarks);
      return;
    }

    const cellText = (r: number, c: number) => toLines(page.texts.filter((t) => inTable(t) && t.y + 3 < ys[r] && t.y + 3 > ys[r + 1] && t.x + t.w / 2 < xs[c] && t.x + t.w / 2 > xs[c + 1])).map((l) => l.text);
    const cols = xs.length - 1, rows = ys.length - 1;

    const days: ParsedDay[] = [];
    const dayOfCol = new Map<number, ParsedDay>();
    for (let c = 1; c < cols; c++) {
      const lines = cellText(0, c);
      const nameAt = lines.findIndex((l) => WEEKDAYS.some((d) => l === d || l.split(" ").includes(d)));
      if (nameAt < 0) { if (lines.length > 0) out.warnings.push(`עמודה בלי שם יום: ${lines.join(" ")}`); continue; }
      const weekday = WEEKDAYS.findIndex((d) => lines[nameAt] === d || lines[nameAt].split(" ").includes(d));
      const rest = [...lines.slice(0, nameAt), lines[nameAt].split(" ").filter((w) => w !== WEEKDAYS[weekday]).join(" "), ...lines.slice(nameAt + 1)].filter(Boolean).join(" ");
      const day: ParsedDay = { weekday, note: rest || null, cells: [] };
      days.push(day);
      dayOfCol.set(c, day);
    }
    if (days.length === 0) throw new MenuParseError("בטבלת התפריט לא נמצאו שמות הימים (ראשון, שני…).");

    let previous: CellCategory | null = null;
    for (let r = 1; r < rows; r++) {
      const label = cellText(r, 0).join(" ");
      const category = categoryOf(label);
      for (const [c, day] of dayOfCol) {
        const lines = cellText(r, c).filter((l) => !/^[-–—]+$/.test(l));
        if (lines.length === 0) continue;
        if (category === "sku") {
          const cell = day.cells.find((x) => x.category === previous);
          if (cell) cell.sku = lines.join(" ");
          continue;
        }
        const text = (category === "other" && label ? `${label}: ` : "") + lines.join("\n");
        const same = day.cells.find((x) => x.category === category);
        if (same) same.text += `\n${text}`;
        else day.cells.push({ category, text, sku: null });
      }
      if (category !== "sku") previous = category;
    }

    const used = new Set(out.weeks.map((w) => w.weekNo));
    if (weekNo === null || used.has(weekNo)) {
      let free = 1;
      while (used.has(free)) free++;
      out.warnings.push(weekNo === null ? `בעמוד ${pageIndex + 1} לא נמצא מספר השבוע; הוא נקלט כשבוע ${free}.` : `שבוע ${weekNo} מופיע פעמיים; העמוד ${pageIndex + 1} נקלט כשבוע ${free}.`);
      weekNo = free;
    }
    if (starts.length === 0) out.warnings.push(`לשבוע ${weekNo} לא נמצאו תאריכים.`);
    days.sort((a, b) => a.weekday - b.weekday);
    out.weeks.push({ weekNo, starts: [...new Set(starts)].sort(), days });
    if (remarks.length > 0) notes.push(`שבוע ${weekNo}: ${remarks.join(" ")}`);
  });

  if (out.weeks.length === 0) throw new MenuParseError("בקובץ לא נמצאה טבלת תפריט. הקובץ צריך להיות מסמך התפריט המאושר, עם טבלה לכל שבוע.");
  out.weeks.sort((a, b) => a.weekNo - b.weekNo);
  const seen = new Map<string, number>();
  for (const w of out.weeks) for (const s of w.starts) {
    if (seen.has(s)) out.warnings.push(`השבוע שמתחיל ב-${s} מופיע גם בשבוע ${seen.get(s)} וגם בשבוע ${w.weekNo}.`);
    else seen.set(s, w.weekNo);
  }
  out.notes = notes.length > 0 ? notes.join("\n") : null;
  return out;
}
