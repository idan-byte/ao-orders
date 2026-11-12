import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { addressesOf, variantsBySku } from "@/lib/orders-data";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { StandingEditor } from "@/components/standing-editor";
import { saveStandingAction } from "../actions";

export default function NewStandingPage({ searchParams }: PageProps<"/standing/new">) {
  return (
    <Suspense fallback={<Loading />}>
      <NewStanding searchParams={searchParams} />
    </Suspense>
  );
}

async function NewStanding({ searchParams }: { searchParams: PageProps<"/standing/new">["searchParams"] }) {
  const { allowed } = await requirePermission("orders.edit");
  if (!allowed) return <NoAccess />;
  const sp = await searchParams;
  const customerId = typeof sp.customer === "string" && /^[0-9a-f-]{36}$/i.test(sp.customer) ? sp.customer : "";
  const [customer] = customerId ? await query<{ id: string; name: string; today: string }>("select id::text, name, (now() at time zone 'Asia/Jerusalem')::date::text as today from customers where id = $1 and active", [customerId]) : [];
  if (!customer) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="font-display text-2xl font-bold">הלקוח לא נמצא</h1>
        <Link href="/standing" className="rounded-lg border border-line px-3 py-1.5 text-sm">
          חזרה להזמנות הקבועות
        </Link>
      </div>
    );
  }
  const variants = await variantsBySku(null);
  const products = (await query<{ sku: string; name: string }>("select p.sku, p.name from products p join product_ops o on o.sku = p.sku where o.orderable order by p.name")).map((p) => ({ ...p, variants: variants.get(p.sku) ?? [] }));
  const addresses = await addressesOf(customer.id);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">הזמנה קבועה חדשה · {customer.name}</h1>
        <Link href="/standing" className="rounded-lg border border-line px-3 py-1.5 text-sm">
          חזרה להזמנות הקבועות
        </Link>
      </div>
      <StandingEditor
        action={saveStandingAction}
        products={products}
        addresses={addresses}
        initial={{ standingId: "", customerId: customer.id, rows: [], addressId: addresses[0]?.id ?? "", windowFrom: "", windowTo: "", validFrom: customer.today, validTo: "", productionNotes: "", shippingNotes: "" }}
      />
    </div>
  );
}
