-- Customer sync: accounts that received a sales document in the last 24 months (read-only).
-- Verified against the live database: 373 rows on 2026-11-11.
-- The documents table is aggregated once and joined, instead of a lookup per account (that form took ~26 seconds).
SELECT
    a.AccountKey                    AS account_key,
    a.FullName                      AS name,
    a.TaxFileNum                    AS tax_id,
    a.Address                       AS address,
    a.City                          AS city,
    a.Phone                         AS phone,
    a.CreditTermsCode               AS credit_terms_code,
    a.TFtalDiscount                 AS fixed_discount_pct,
    CAST(a.VatExampt AS int)        AS vat_exempt,
    d.last_doc                      AS last_document_date
FROM Accounts a
JOIN (
    SELECT s.AccountKey, MAX(s.ValueDate) AS last_doc
    FROM Stock s
    WHERE s.DocumentID IN (1, 3, 4, 37)       -- invoice, credit invoice, delivery note, summary invoice
      AND s.ValueDate >= DATEADD(month, -24, GETDATE())
    GROUP BY s.AccountKey
) d ON d.AccountKey = a.AccountKey
ORDER BY a.FullName;
