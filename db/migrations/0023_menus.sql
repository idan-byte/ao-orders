-- Hot food, part 3: menus. A Milgam menu is closed in advance and cyclic: a few weeks (usually four) that repeat,
-- approved by Milgam's dietitian. Every institution follows one menu. For every week of the cycle and every weekday
-- the menu says what is served in each category, as written in the approved document.

create table menus (
    id           serial primary key,
    name         text not null unique,
    active       boolean not null default true,
    weeks        int not null default 4 check (weeks between 1 and 8),
    period       text,                 -- "אוקטובר - דצמבר 2026", as written on the document
    approved_by  text,                 -- the dietitian
    approved_on  date,
    notes        text,                 -- the document's remarks and instructions, whole
    source_file  text,                 -- the file the menu was built from, when it was uploaded
    created_at   timestamptz not null default now()
);

alter table institutions add column menu_id int references menus(id);

-- Which week of the cycle a calendar week is. A week is named by its Sunday.
create table menu_week_starts (
    menu_id     int not null references menus(id),
    week_start  date not null check (extract(dow from week_start) = 0),
    week_no     int not null check (week_no between 1 and 8),
    primary key (menu_id, week_start)
);

-- One cell of the menu's table. weekday: 0 = Sunday ... 5 = Friday.
-- 'day_note' is the remark in the day's heading ("שוברת שגרה לבתי ספר בלבד").
create table menu_cells (
    menu_id   int not null references menus(id),
    week_no   int not null check (week_no between 1 and 8),
    weekday   int not null check (weekday between 0 and 5),
    category  text not null check (category in ('day_note', 'main', 'grain', 'hot_side', 'vegetarian', 'allergen_free', 'vegetable', 'fruit', 'bread', 'other')),
    text      text not null check (length(btrim(text)) > 0),
    sku       text,                    -- the מק"ט line under the main, vegetarian and allergen-free rows
    primary key (menu_id, week_no, weekday, category)
);

-- The dish table of Milgam: the portion weight of every dish for every age group, in kilograms.
create table dishes (
    id               serial primary key,
    code             int unique,                       -- Milgam's code of the dish
    category         text not null check (category in ('main', 'grain', 'hot_side', 'vegetarian', 'allergen_free', 'vegetable', 'fruit', 'bread', 'other')),
    name             text not null check (length(btrim(name)) > 0),
    weight_gan       numeric(8,3) check (weight_gan >= 0),
    weight_ab        numeric(8,3) check (weight_ab >= 0),
    weight_gv        numeric(8,3) check (weight_gv >= 0),
    weight_high      numeric(8,3) check (weight_high >= 0),
    kilo_box_weight  numeric(8,3) check (kilo_box_weight >= 0),   -- "משקל בקופסת קילו"
    raw_ratio        numeric(8,2) check (raw_ratio >= 0),         -- "יחס חומר גולמי", in percent
    routine_breaker  boolean not null default false,              -- "שובר שגרה"
    active           boolean not null default true,
    created_at       timestamptz not null default now()
);
create index on dishes (category, name);

-- A meal type of Milgam belongs to an age group and to a diet. Both are guessed from its name when it is first
-- seen ("חמגשית צמחוני ג-ו") and can be corrected by a person.
alter table meal_types add column age_group text check (age_group in ('gan', 'ab', 'gv', 'high'));
alter table meal_types add column diet text not null default 'regular' check (diet in ('regular', 'vegetarian', 'allergen_free'));

update meal_types set age_group = case
    when name like '%על יסודי%' then 'high'
    when name like '%ג-ו%' then 'gv'
    when name like '%א-ב%' then 'ab'
    when name ~ '(^|\s)(גן|גנים|חובה)(\s|$)' then 'gan'
end;
update meal_types set diet = case
    when name like '%אלרג%' then 'allergen_free'
    when name like '%צמחונ%' or name like '%טבעונ%' then 'vegetarian'
    else 'regular'
end;

-- What the upload was unsure about, shown on the menu until a person says it was checked.
alter table menus add column upload_warnings text;
