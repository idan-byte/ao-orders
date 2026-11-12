import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { canEdit, STATUS_LABEL, type DeliveryStatus } from "@/lib/orders-core";
import { addressesOf, productsForCustomer } from "@/lib/orders-data";
import { LinesEditor } from "@/components/lines-editor";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { updateDeliveryAction } from "../../../actions";

export default function EditDeliveryPage({ params }: PageProps<"/orders/[id]/edit/[deliveryId]">) {
  return (
    <Suspense fallback={<Loading />}>
      <EditDelivery params={params} />
    </Suspense>
  );
}

async function EditDelivery({ params }: { params: PageProps<"/orders/[id]/edit/[deliveryId]">["params"] }) {
  const { user, allowed } = await requirePermission("orders.edit");
  if (!allowed) return <NoAccess />;
  const { id, deliveryId } = await params;
  const ok = /^[0-9a-f-]{36}$/i.test(id) && /^[0-9a-f-]{36}$/i.test(deliveryId);
  const [d] = ok
    ? await query<{ number: number; customer_id: string; customer: string; vat_exempt: boolean; status: DeliveryStatus; delivery_date: string; window_from: string | null; window_to: string | null; address_id: string | null; production_notes: string | null; shipping_notes: string | null }>(
        `select o.number, o.customer_id::text, c.name as customer, c.vat_exempt, d.status::text as status, d.delivery_date::text,
                to_char(d.window_from, 'HH24:MI') as window_from, to_char(d.window_to, 'HH24:MI') as window_to, d.address_id::text, d.production_notes, d.shipping_notes
         from deliveries d join orders o on o.id = d.order_id join customers c on c.id = o.customer_id
         where d.id = $1 and o.id = $2`,
        [deliveryId, id],
      )
    : [];
  const back = (
    <Link href={`/orders/${id}`} className="rounded-lg border border-line px-3 py-1.5 text-sm">
      חזרה להזמנה
    </Link>
  );
  if (!d) return <div className="flex flex-col gap-3"><h1 className="font-display text-2xl font-bold">האספקה לא נמצאה</h1></div>;
  if (!canEdit(d.status)) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="font-display text-2xl font-bold">אי אפשר לשנות את האספקה</h1>
        <p className="text-muted">אספקה במצב ״{STATUS_LABEL[d.status]}״ נעולה לשינויים.</p>
        {back}
      </div>
    );
  }
  const lines = await query<{ id: string; sku: string; variant_id: number | null; name: string; quantity: number; unit_price: number; discount_pct: number }>(
    "select l.id::text, l.sku, l.variant_id, p.name, l.quantity::float, l.unit_price::float, l.discount_pct::float from delivery_lines l join products p on p.sku = l.sku where l.delivery_id = $1 order by l.id",
    [deliveryId],
  );
  const products = await productsForCustomer(d.customer_id, d.delivery_date, deliveryId);
  const addresses = await addressesOf(d.customer_id);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">
          שינוי אספקה · הזמנה <span dir="ltr">{d.number}</span> · {d.customer}
        </h1>
        {back}
      </div>
      <p className="rounded-lg bg-sunken px-3 py-2 text-sm">
        כל שינוי נרשם בהיסטוריית ההזמנה: מה השתנה, מי שינה ומתי.
        {d.status === "in_production" ? " האספקה כבר בייצור, ולכן כדאי לעדכן גם את המחלקה." : ""}
        {!can(user.role, "prices.edit") ? " מחירים של שורות קיימות נשמרים כפי שהם; שינוי מחיר דורש הרשאת תמחור." : ""}
      </p>
      <LinesEditor
        mode="delivery"
        idName="delivery_id"
        action={updateDeliveryAction}
        products={products}
        addresses={addresses}
        initial={{
          quoteId: deliveryId,
          version: 1,
          customerVatExempt: d.vat_exempt,
          lines: lines.map((l) => ({ key: l.id, sku: l.sku, variantId: l.variant_id === null ? "" : String(l.variant_id), description: l.name, quantity: String(l.quantity), unitPrice: String(l.unit_price), discountPct: l.discount_pct ? String(l.discount_pct) : "", deliveryDate: "" })),
          discountPct: "",
          deliveryFee: "",
          deliveryDate: d.delivery_date,
          windowFrom: d.window_from ?? "",
          windowTo: d.window_to ?? "",
          addressId: d.address_id ?? "",
          customerNotes: d.shipping_notes ?? "",
          internalNotes: d.production_notes ?? "",
          validUntil: "",
          paymentTerms: "",
        }}
      />
    </div>
  );
}
