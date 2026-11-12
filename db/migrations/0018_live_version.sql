-- Live updates between devices: a counter that moves after every committed change.
-- Screens ask for its value every few seconds and reload their data when it has moved.
-- A sequence is used because advancing it never waits for another transaction.
create sequence live_version;
