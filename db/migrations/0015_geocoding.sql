-- Route map: where each delivery address is on the map.
-- latitude/longitude exist since the first migration; this records how they were found.
--   found      located by the address search service
--   manual     placed on the map by a person; the search never overwrites it
--   not_found  the search had no answer, or the address has no usable text
-- null means the address was never searched.
alter table customer_addresses add column geocode_status text check (geocode_status in ('found', 'manual', 'not_found'));
alter table customer_addresses add column geocode_query text;        -- the text that was searched, so a changed address is searched again
alter table customer_addresses add column geocoded_at timestamptz;
