-- The business details given by the owner, on the default letterhead.
-- Applied only if nobody has edited that line on the letterheads screen in the meantime.
update letterheads
set subtitle = 'התוצרת 4, עטרות, ירושלים · משרד 02-6336530 · עידן, מנהל מכירות 052-5635417 · info@ao-food.co.il'
where name = 'כללי' and subtitle = 'A&O Food Services · אזור התעשייה עטרות, ירושלים';
