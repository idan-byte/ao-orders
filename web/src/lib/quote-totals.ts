// Pure money maths for quotes and orders. No Node or Next imports, so the browser editor uses the same code as the server.

export const VAT_RATE = 0.18;
export const DEFAULT_VALID_DAYS = 14;

export type LineInput = {
  sku: string;
  variantId?: number | null;
  description: string;
  quantity: number;
  unitPrice: number;
  discountPct?: number;
  deliveryDate?: string | null;
  vatExempt?: boolean;
};

export type Totals = { lines: number[]; subtotal: number; discount: number; deliveryFee: number; beforeVat: number; vat: number; total: number };

// Money is computed in whole agorot. The small epsilon keeps values like 1.005 from rounding down
// because of binary floating point.
const agorot = (shekels: number) => Math.round(shekels * 100 + 1e-6);
const shekels = (a: number) => a / 100;

/**
 * Line totals are rounded per line. The document discount applies to the sum of lines. VAT is computed once
 * on the taxable part of the document (after discount, plus the delivery fee) and rounded once.
 */
export function computeTotals(
  lines: Pick<LineInput, "quantity" | "unitPrice" | "discountPct" | "vatExempt">[],
  discountPct: number,
  deliveryFee: number,
  vatRate: number,
  customerVatExempt = false,
): Totals {
  const lineA = lines.map((l) => agorot(l.quantity * l.unitPrice * (1 - (l.discountPct ?? 0) / 100)));
  const subtotalA = lineA.reduce((s, x) => s + x, 0);
  const taxableLinesA = lineA.reduce((s, x, i) => s + (lines[i].vatExempt ? 0 : x), 0);
  const factor = 1 - discountPct / 100;
  const afterA = Math.round(subtotalA * factor + 1e-6);
  const taxableAfterA = Math.round(taxableLinesA * factor + 1e-6);
  const feeA = agorot(deliveryFee);
  const vatA = customerVatExempt ? 0 : Math.round((taxableAfterA + feeA) * vatRate + 1e-6);
  const beforeA = afterA + feeA;
  return {
    lines: lineA.map(shekels),
    subtotal: shekels(subtotalA),
    discount: shekels(subtotalA - afterA),
    deliveryFee: shekels(feeA),
    beforeVat: shekels(beforeA),
    vat: shekels(vatA),
    total: shekels(beforeA + vatA),
  };
}
