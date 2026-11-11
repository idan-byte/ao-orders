-- Seed for customer price agreements: the last price each customer was charged per sale item (read-only).
-- Verified against the live database on 2026-11-11: 903 rows, 256 customers, 120 items.
-- Prices are before VAT. Rows are a starting point only: a person reviews them before they become an agreement.
-- Known outlier to review: at least one row has a unit price above 30,000.
WITH lp AS (
    SELECT
        s.AccountKey,
        m.ItemKey,
        m.Price,
        s.ValueDate,
        s.DocumentID,
        s.DocNumber,
        ROW_NUMBER() OVER (
            PARTITION BY s.AccountKey, m.ItemKey
            ORDER BY s.ValueDate DESC, s.ID DESC, m.ID DESC
        ) AS rn
    FROM StockMoves m
    JOIN Stock s ON s.ID = m.StockID
    JOIN Items i ON i.ItemKey = m.ItemKey
    WHERE s.DocumentID IN (1, 4, 37)
      AND s.ValueDate >= DATEADD(month, -12, GETDATE())
      AND i.SortGroup IN (500, 600, 630, 650)
      AND m.Price > 0
      AND m.Quantity > 0
)
SELECT
    AccountKey  AS account_key,
    ItemKey     AS sku,
    Price       AS last_price_ex_vat,
    ValueDate   AS charged_on,
    DocumentID  AS source_document_type,
    DocNumber   AS source_document_number
FROM lp
WHERE rn = 1
ORDER BY AccountKey, ItemKey;
