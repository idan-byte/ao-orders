import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { Loading } from "@/components/loading";

// The page shell renders instantly; the data-dependent part streams in behind the Suspense boundary.
export default function Home() {
  return (
    <Suspense fallback={<Loading />}>
      <HomeContent />
    </Suspense>
  );
}

async function HomeContent() {
  const [stats] = await query<{ products: number; departments: number; tables: number }>(`
    select (select count(*)::int from products) as products,
           (select count(*)::int from departments) as departments,
           (select count(*)::int from information_schema.tables where table_schema = 'public') as tables`);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">מהדורה 1 בבנייה</h1>
      <p className="max-w-prose text-muted">
        שלד המערכת רץ מול מסד נתונים אמיתי. המסכים נבנים לפי הסדר: לקוחות ומחירים, הצעות מחיר ו-CRM, הזמנות, ייצור, תעודת משלוח.
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
        <Stat value={stats.products} label="מוצרים מחשבשבת" />
        <Stat value={stats.departments} label="מחלקות ייצור" />
        <Stat value={stats.tables} label="טבלאות במסד" />
      </div>
      <Link href="/catalog" className="w-fit rounded-lg bg-accent px-4 py-2 font-medium text-surface">
        לקטלוג
      </Link>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <b className="block font-display text-3xl tabular-nums">{value.toLocaleString("he-IL")}</b>
      <span className="text-sm text-muted">{label}</span>
    </div>
  );
}
