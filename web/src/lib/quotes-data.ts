import { query } from "@/lib/db";

export type QuoteDoc = {
  quoteId: string;
  number: number;
  status: string;
  validUntil: string | null;
  paymentTerms: string | null;
  customerName: string;
  customerTaxId: string | null;
  versionId: string;
  version: number;
  sentAt: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  approvalMethod: string | null;
  discountPct: number;
  deliveryFee: number;
  vatRate: number;
  beforeVat: number;
  vat: number;
  total: number;
  deliveryDate: string | null;
  windowFrom: string | null;
  windowTo: string | null;
  address: string | null;
  customerNotes: string | null;
  letterhead: { id: number; name: string; title: string; subtitle: string | null; footer: string | null; logoUrl: string | null };
  isLatest: boolean;
  expired: boolean;
  lines: { position: number; sku: string; description: string; quantity: number; unitPrice: number; discountPct: number; deliveryDate: string | null; lineTotal: number }[];
};

/** Everything needed to show one version of a quote as a document. Internal notes are deliberately not included. */
export async function loadQuoteDoc(versionId: string): Promise<QuoteDoc | null> {
  const [h] = await query<{
    quote_id: string; number: number; status: string; valid_until: string | null; payment_terms: string | null; customer: string; tax_id: string | null;
    version: number; sent_at: string | null; approved_at: string | null; approved_by_name: string | null; approval_method: string | null;
    discount_pct: number; delivery_fee: number; vat_rate: number; before_vat: number; vat: number; total: number;
    delivery_date: string | null; window_from: string | null; window_to: string | null; address: string | null; customer_notes: string | null;
    is_latest: boolean; expired: boolean;
    lh_id: number; lh_name: string; lh_title: string; lh_subtitle: string | null; lh_footer: string | null; lh_logo: string | null;
  }>(
    `select qt.id::text as quote_id, qt.number, qt.status::text, qt.valid_until::text, qt.payment_terms, c.name as customer, c.tax_id,
            v.version, v.sent_at::text, v.approved_at::text, v.approved_by_name, v.approval_method,
            v.discount_pct::float, v.delivery_fee::float, v.vat_rate::float, v.total_before_vat::float as before_vat, v.total_vat::float as vat, v.total::float,
            v.delivery_date::text, to_char(v.window_from, 'HH24:MI') as window_from, to_char(v.window_to, 'HH24:MI') as window_to,
            (select concat_ws(', ', a.street, a.city) from customer_addresses a where a.id = v.address_id) as address,
            v.customer_notes,
            lh.id as lh_id, lh.name as lh_name, lh.title as lh_title, lh.subtitle as lh_subtitle, lh.footer as lh_footer,
            case when lh.logo is not null then extract(epoch from lh.logo_updated_at)::bigint::text end as lh_logo,
            v.version = (select max(version) from quote_versions where quote_id = qt.id and sent_at is not null) as is_latest,
            coalesce(qt.valid_until < (now() at time zone 'Asia/Jerusalem')::date, false) as expired
     from quote_versions v join quotes qt on qt.id = v.quote_id join customers c on c.id = qt.customer_id
     join letterheads lh on lh.id = coalesce(qt.letterhead_id, (select id from letterheads where is_default))
     where v.id = $1`,
    [versionId],
  );
  if (!h) return null;
  const lines = await query<{ position: number; sku: string; description: string; quantity: number; unit_price: number; discount_pct: number; delivery_date: string | null; line_total: number }>(
    `select position, sku, description, quantity::float, unit_price::float, discount_pct::float, delivery_date::text,
            round(quantity * unit_price * (1 - discount_pct / 100), 2)::float as line_total
     from quote_lines where quote_version_id = $1 order by position`,
    [versionId],
  );
  return {
    quoteId: h.quote_id, number: h.number, status: h.status, validUntil: h.valid_until, paymentTerms: h.payment_terms, customerName: h.customer, customerTaxId: h.tax_id,
    versionId, version: h.version, sentAt: h.sent_at, approvedAt: h.approved_at, approvedByName: h.approved_by_name, approvalMethod: h.approval_method,
    discountPct: h.discount_pct, deliveryFee: h.delivery_fee, vatRate: h.vat_rate, beforeVat: h.before_vat, vat: h.vat, total: h.total,
    deliveryDate: h.delivery_date, windowFrom: h.window_from, windowTo: h.window_to, address: h.address, customerNotes: h.customer_notes,
    letterhead: { id: h.lh_id, name: h.lh_name, title: h.lh_title, subtitle: h.lh_subtitle, footer: h.lh_footer, logoUrl: h.lh_logo ? `/letterheads/${h.lh_id}/logo?v=${h.lh_logo}` : null },
    isLatest: h.is_latest, expired: h.expired,
    lines: lines.map((l) => ({ position: l.position, sku: l.sku, description: l.description, quantity: l.quantity, unitPrice: l.unit_price, discountPct: l.discount_pct, deliveryDate: l.delivery_date, lineTotal: l.line_total })),
  };
}

export const QUOTE_STATUS: Record<string, string> = {
  draft: "טיוטה",
  sent: "נשלחה",
  follow_up: "במעקב",
  approved: "אושרה",
  rejected: "נדחתה",
  expired: "פג תוקף",
};
