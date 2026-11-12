import { query } from "@/lib/db";
import type { EditorProduct } from "@/components/lines-editor";

/** Orderable products with the price this customer gets on a date: the agreed price if one applies, else the base price. */
export async function productsForCustomer(customerId: string, onDate: string, alsoDeliveryId?: string): Promise<EditorProduct[]> {
  const rows = await query<{ sku: string; name: string; vat_exempt: boolean; base_price: number; agreed_price: number | null }>(
    `select p.sku, p.name, p.vat_exempt, p.base_price::float,
            (select cp.price::float from customer_prices cp
             where cp.customer_id = $1 and cp.sku = p.sku and cp.approved_at is not null and cp.valid_from <= $2::date and (cp.valid_to is null or cp.valid_to >= $2::date)
             order by cp.valid_from desc, cp.id desc limit 1) as agreed_price
     from products p join product_ops o on o.sku = p.sku
     where o.orderable or p.sku in (select sku from delivery_lines where delivery_id = $3)
     order by p.name`,
    [customerId, onDate, alsoDeliveryId ?? null],
  );
  return rows.map((p) => ({ sku: p.sku, name: p.name, vatExempt: p.vat_exempt, price: p.agreed_price ?? p.base_price, agreed: p.agreed_price !== null }));
}

export async function addressesOf(customerId: string): Promise<{ id: string; text: string }[]> {
  return query<{ id: string; text: string }>("select id::text, concat_ws(', ', street, city) as text from customer_addresses where customer_id = $1 order by is_default desc, street", [customerId]);
}

export const SOURCE_LABEL: Record<string, string> = {
  manual: "הזנה ידנית",
  standing: "הזמנה קבועה",
  quote: "הצעת מחיר",
  email: "מייל",
  whatsapp: "וואטסאפ",
  website: "אתר",
  portal: "פורטל לקוחות",
};
