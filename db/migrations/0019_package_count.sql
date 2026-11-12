-- How many packages (crates, trays, cartons) a delivery goes out in. Every package gets its own label,
-- all carrying the delivery's one scan code: scanning any of them marks the whole delivery.
alter table deliveries add column package_count int not null default 1 check (package_count between 1 and 99);
