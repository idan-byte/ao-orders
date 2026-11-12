import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { addressesOf, productsForCustomer } from "@/lib/orders-data";
import { LinesEditor } from "@/components/lines-editor";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { createOrderAction } from "../actions";

export default function NewOrderPage({ searchParams }: PageProps<"/orders/new">) {
  return (
    <Suspense fallback={<Loading />}>
      <NewOrder searchParams={searchParams} />
    </Suspense>
  );
}

async function NewOrder({ searchParams }: { searchParams: PageProps<"/orders/new">["searchParams"] }) {
  const { user, allowed } = await requirePermission("orders.edit");
  if (!allowed) return <NoAccess />;
  const sp = await searchParams;
  const customerId = typeof sp.customer === "string" && /^[0-9a-f-]{36}$/i.test(sp.customer) ? sp.customer : "";
  const [customer] = customerId
    ? await query<{ id: string; name: string; vat_exempt: boolean; today: string }>("select id::text, name, vat_exempt, (now() at time zone 'Asia/Jerusalem')::date::text as today from customers where id = $1 and active", [customerId])
    : [];

  if (!customer) {
    const customers = await query<{ id: string; name: string }>("select id::text, name from customers where active order by name");
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-2xl font-bold">הזמנה חדשה</h1>
        <section className="rounded-xl border border-line bg-surface p-4">
          {customers.length === 0 ? (
            <p className="text-muted">אין עדיין לקוחות. סנכרון מחשבשבת במסך הלקוחות יטען אותם.</p>
          ) : (
            <form action="/orders/new" className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm text-muted">
                לקוח
                <select id="order-customer" name="customer" required defaultValue="" className="max-w-xs rounded-lg border border-line bg-surface px-3 py-2 text-foreground">
                  <option value="">בחירה</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className="rounded-lg bg-accent px-4 py-2 font-medium text-surface">המשך</button>
            </form>
          )}
        </section>
      </div>
    );
  }

  const products = await productsForCustomer(customer.id, customer.today);
  const addresses = await addressesOf(customer.id);
  const mayPrice = can(user.role, "prices.edit");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">הזמנה חדשה · {customer.name}</h1>
        <Link href="/orders/new" className="rounded-lg border border-line px-3 py-1.5 text-sm">
          לקוח אחר
        </Link>
      </div>
      {addresses.length === 0 ? (
        <p className="rounded-lg bg-sunken px-3 py-2 text-sm">
          ללקוח אין כתובת אספקה. אפשר להוסיף אותה ב
          <Link href={`/customers/${customer.id}`} className="text-accent underline">
            כרטיס הלקוח
          </Link>
          .
        </p>
      ) : null}
      {!mayPrice ? <p className="rounded-lg bg-sunken px-3 py-2 text-sm">המחירים נקבעים לפי הסכם הלקוח או מחיר הבסיס. שינוי מחיר או הנחה דורש הרשאת תמחור.</p> : null}
      <LinesEditor
        mode="order"
        idName="customer_id"
        action={createOrderAction}
        products={products}
        addresses={addresses}
        initial={{
          quoteId: customer.id,
          version: 1,
          customerVatExempt: customer.vat_exempt,
          lines: [],
          discountPct: "",
          deliveryFee: "",
          deliveryDate: "",
          windowFrom: "",
          windowTo: "",
          addressId: addresses[0]?.id ?? "",
          customerNotes: "",
          internalNotes: "",
          validUntil: "",
          paymentTerms: "",
        }}
      />
    </div>
  );
}
