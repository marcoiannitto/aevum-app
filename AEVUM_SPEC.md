# AEVUM APP — MASTER SPEC

Single source of truth. Paste to Claude at the start of a session.
Last updated: keep this current when decisions change.

---

## 1. WHAT THE APP IS

A mobile web app (hosted at app.niramaya.sg) that guides a client through the
35-day AEVUM metabolic program (PSMF + 16/8 fasting). Runs as a static HTML app
on GitHub Pages, with a Google Apps Script backend + Google Sheet for data,
AI (Claude Haiku) for food estimation, and a bundled/hosted USDA food database.

Stack:
- Frontend: single index.html on GitHub Pages, custom domain app.niramaya.sg
- Backend: Google Apps Script web app (one /exec URL in BACKEND_URL)
- Data: one Google Sheet, tabs: Data, Recipes, Foods(unused), Profile, MealPlan
- AI: Anthropic API key in Script Properties (Claude Haiku)
- Food DB: usda_database_simplified.json hosted on GitHub, fetched + cached
- Per-person via ?id= in the URL (label, not auth)

---

## 2. THE PROGRAM — PHASES

35 days, four phases:

| Phase | Days | Serum | Diet | Gates |
|---|---|---|---|---|
| Loading | 1–2 | 2×/day | Eat more, incl. carbs | none (track only) |
| Activation | 3–14 | 2×/day | PSMF, ~500 kcal, 16/8 fast | full gates |
| Transition | 15–16 | none | PSMF, same as Activation | full gates |
| Consolidation | 17–35 | none | Keto maintenance | carbs + calorie bar |

Principle: PSMF (protein-sparing modified fast). High protein protects muscle,
minimal fat + carbs so the body burns its own fat.

---

## 3. DAILY LIMITS & GATES (Activation / Transition)

Per DAY:
- Calories: target 500, orange 500–600, red >600
- Fat: ok ≤20g, orange 20–25, red >25
- Carbs: ok ≤25g, orange 25–30, red >30
- Protein: target = onboarding weight × 1.2 (shown as progress, never "fails")

Per MEAL red flags (Activation/Transition only, shown in Log sheet):
- kcal >250 · fat >10 · carbs >15 (label shows "max N")

Consolidation:
- Calories: bar vs (need + exercise kcal); orange >100%, red >130%
- Carbs: ceiling only
- Fat: track only

Loading (1–2): everything track only, no gates.

16/8 fasting (Activation only): rolling from last meal. States:
- Eating window · till HH:MM (within 8h of window start)
- Fasting · eat at HH:MM (window closed, <16h since last meal)
- You can eat now (16h passed)

Water goal: 2.5 L = 10 glasses/day (250ml each).

---

## 4. FOOD ACCEPTABILITY RULES (the core ruleset)

Judged per 100g, raw.

### Vegetables & fruit — by net carbs, sugar, fat, and added sugar/oil/starch:
- **Free:** net carbs <5g, sugar <5g, fat <3g, no added sugar/oil/starch
- **Limited:** net carbs 5–15g, sugar 5–12g, fat 3–10g
- **Not allowed:** net carbs >15g, sugar >12g, fat >10g, or any added sugar/oil/starch
- Free list: bean sprouts, spinach, lettuce, cucumber, celery, asparagus, radish, fennel, tomato, cabbage, mushroom, bell pepper, broccoli
- Limited list: carrot, onion, beetroot, green beans, apple, orange, berries
- Not allowed list: banana, grape, mango, cherry, dried fruit, potato, + anything with added sugar/oil/starch

### Proteins — judged on FAT only:
- **Free:** fat <5g
- **Limited:** fat 5–10g
- **Not allowed:** fat >10g, plus oily fish, cured/processed, skin-on dark meat
- Free list: chicken breast, white fish (cod, tilapia, halibut, haddock, sole), prawn, egg white, 0% Greek yogurt
- Limited list: whole egg, tofu, lean beef
- Not allowed list: salmon, tuna, mackerel, pork, bacon, sausage, dark meat with skin, tempeh

### Cooking — method can move a Free food to Not allowed:
- No oil/butter/sugar/starchy sauces
- Steam, boil, grill, bake dry, or water-sauté only
- Trim visible fat before cooking

Principle: low fat, low carb/sugar, high protein, whole foods only.

---

## 5. THE FOUR NUTRITION MODULES

They share one food engine (USDA + rules + quantity scaling). A food is judged
and counted identically everywhere.

### A. Can I Eat (quick check, per ingredient)
- User types a food → verdict: **Yes / Limited / No**
  - Yes = eat, quantity per meal plan
  - Limited = eat, capped by carb/fat ceiling (show the cap)
  - No = not allowed
- Lookup: USDA first → real macros → rules → verdict (instant).
  Miss → AI estimates macros → same rules classify (never AI's opinion).
- BULLETPROOF: always show the matched food name so user can reject a bad match.

### B. Log a meal (what they actually ate)
Three ways in, one editable macro result out → log:
1. Structured: food + quantity, line by line → "Calculate with AI" (USDA where possible)
2. Photo / gallery → AI estimation
3. Free text ("chicken parmigiana 500g") → AI computes
Always editable before saving. Quantity-aware (rules are per 100g, scale to grams).

### C. Nutrition tab (Plan + Recipes)
Two sub-views under one "Nutrition" nav tab:
- **Plan** (default): the client's day-by-day meal plan. Built BY Marco in the
  MealPlan sheet tab, per person. Display-only (not auto-logged). Shows per-meal
  + per-day macro totals. Purpose: (1) tell partner what to prep, (2) stop
  self-cookers getting bored. Each planned meal:
    - tap → see recipe (ingredients, steps)
    - "Log this today" button → one-tap log (macros known)
    - "Add meal" → pick from Recipes → add to a day (saves LOCAL only)
- **Recipes**: the full recipe book, browsable, for swaps.

### D. Meal Plan data
MealPlan sheet tab: id | day | meal | recipe | kcal | protein | fat | carbs
Recipes linked by name to the Recipes tab (for steps/ingredients).

---

## 6. NAV STRUCTURE

Today · Daily · Nutrition · Trends

- Today: serum, calorie+gate status, water, log meal, timeline, fasting status, "Can I eat?"
- Daily: weight, waist, movement, energy/hunger/sleep, notes
- Nutrition: Plan (default) + Recipes sub-views
- Trends: weight & waist charts (scrub, target line), CSV export

---

## 7. FOOD DATABASE (usda_database_simplified.json)

Source: USDA SR Legacy. ~7,793 foods. Hosted on GitHub, fetched + cached.
Per entry: n(name) t(type p/v/f/d/o) f(fat) c(net carbs) s(sugar) k(kcal) p(protein) v(verdict f/l/x)
Verdict pre-computed with the section-4 rules + override lists.
App applies quantity scaling at runtime. Search must be bulletproof (ranked,
prefer "raw", deprioritize oil/dried/salad/juice, show matched name).

---

## 8. BUILD ORDER (current)

DONE: fasting fix, weight math, weight chart (scrub/target), Profile tab.
NEXT:
1. Food engine (USDA host + lookup + scaling + rules + bulletproof search)
2. Can I Eat rebuild (Yes/Limited/No)
3. Log a meal rebuild (3 input modes)
4. Nutrition tab (Plan + Recipes, MealPlan tab, log-this-today, add-meal local)
STILL OPEN: Log records clickable (tap a logged meal → see original input)

---

## 9. VOICE / STYLE (for any client-facing copy)
Simple words. No em-dashes. Clear and reassuring, not clinical.
Guiding tone ("your only job is to follow the steps").
Never "detox". Participants/clients, never "patients".
Premium feel: ink #1A1A1A, gold #B08D2E, Fraunces serif headings.
