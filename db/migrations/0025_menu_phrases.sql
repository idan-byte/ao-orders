-- Hot food, part 4: from the menu to kilograms. What a menu cell says ("אורז לבן") is tied once to a dish of the
-- dish table; from then on every cell that says the same thing is weighed by that dish. The tie is a person's
-- decision; without one, a phrase that is exactly the name of a single dish of its category is taken as that dish.
create table menu_phrases (
    category  text not null check (category in ('main', 'grain', 'hot_side', 'vegetarian', 'allergen_free', 'vegetable', 'fruit', 'bread', 'other')),
    phrase    text not null check (length(btrim(phrase)) > 0),
    dish_id   int not null references dishes(id),
    primary key (category, phrase)
);
