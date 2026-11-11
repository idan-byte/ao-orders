-- Catalog sync: sale items from Hashavshevet (read-only).
-- Verified against the live database on 2026-11-11: 285 rows, 121 of them sold in the last 12 months.
-- Sale items live in sort groups 500 (sandwiches), 600 (hot food), 630 (catering trays), 650 (misc).
SELECT
    i.ItemKey                       AS sku,
    i.ItemName                      AS name,
    i.SortGroup                     AS sort_group,
    n.SortCodeName                  AS sort_group_name,
    i.Price                         AS base_price_ex_vat,
    i.SalesUnit                     AS sales_unit,
    CAST(i.VatExampt AS int)        AS vat_exempt,
    i.BarCode                       AS barcode,
    ISNULL(u.lines_12m, 0)          AS lines_12m,
    u.last_sold                     AS last_sold
FROM Items i
LEFT JOIN ItemSortNames n ON n.ItemSortCode = i.SortGroup
OUTER APPLY (
    SELECT COUNT(*) AS lines_12m, MAX(s.ValueDate) AS last_sold
    FROM StockMoves m
    JOIN Stock s ON s.ID = m.StockID
    WHERE m.ItemKey = i.ItemKey
      AND s.DocumentID IN (1, 4, 37)          -- tax invoice, delivery note, summary invoice
      AND s.ValueDate >= DATEADD(month, -12, GETDATE())
) u
WHERE i.SortGroup IN (500, 600, 630, 650)
ORDER BY i.SortGroup, i.ItemKey;
