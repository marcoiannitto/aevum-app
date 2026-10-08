/* AEVUM Backend — Cloudflare Worker v1.13.0
   Changes from v1.12.0:
     - ESTIMATE NOW USES POLICY TAB: estimate route accepts body.policy
       (same as foodcheck/mealbuilder). When present, replaces the
       hardcoded RULES for food verdicts. GAS proxy must fetch policy
       for the client's phase and attach it before forwarding.
   Changes from v1.11.2 (carried):
     - FIX: Stabilization fruit rules updated. Was: berries only.
       Now: YES if sugar ≤12.5g/100g (apple, watermelon, etc.);
       LIMITED 12.6-13.5g; NO >13.5g. Matches Policy tab.
     - BUG FIX: MODEL_SMART updated to "claude-sonnet-5-5".
     - BUG FIX (mealbuilder suggest): Protein field = ingredient choice, not macro target.
     - BUG FIX: flags array must be empty unless substitution or rule violation.
     - PARSE ROBUSTNESS: extractJSON walks braces (string-aware); aiJSON retries once.
     - MACRO RELIABILITY: per-ingredient components, Worker sums, Atwater guard.
     - EDITABLE POLICY: foodcheck/mealbuilder/estimate accept policy string from Policy tab.

   Routes: estimate, foodcheck, shoplist, mealbuilder.

   This is the COMPLETE Worker file. Paste it over everything
   in the Cloudflare dashboard, then Save and Deploy.
   ──────────────────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    // CORS
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ error: "POST only" }, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, cors); }

    const KEY = env.ANTHROPIC_KEY;
    // Two knobs. MODEL = cheap/fast (foodcheck, shoplist). MODEL_SMART = accuracy-
    // critical macro math (estimate, mealbuilder). If Anthropic rejects the Sonnet
    // id below, paste the current Sonnet model string here and redeploy.
    const MODEL = "claude-haiku-4-5-20251001";
    const MODEL_SMART = "claude-sonnet-5-5";
    if (!KEY) return json({ error: "no key set" }, cors);

    const PHASE = ["loading", "activation", "stabilization"].includes(body.phase) ? body.phase : "activation";

    // Robust JSON extraction: strips fences, then walks braces (string-aware) to
    // pull the FIRST complete {..} object even if the model added prose or a stray
    // brace. Falls back to first-to-last-brace if the object looks truncated.
    const extractJSON = (txt) => {
      if (!txt) return null;
      let s = String(txt).replace(/```json|```/g, "").trim();
      try { return JSON.parse(s); } catch {}
      // Walk every top-level {..} group (string-aware) and return the first that
      // actually parses — so prose like "I used {broccoli}" before the real JSON
      // doesn't trip us up.
      let depth = 0, start = -1, inStr = false, esc = false;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === "{") { if (depth === 0) start = i; depth++; }
        else if (ch === "}") { if (depth > 0 && --depth === 0 && start >= 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch {} start = -1; } }
      }
      // last resort: first "{" to last "}" (handles minor mid-object noise)
      const a = s.indexOf("{"), b = s.lastIndexOf("}");
      if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
      return null;
    };

    // Deterministic macro guard. Trust the AI's per-ingredient grams + macros,
    // but recompute each item's kcal from Atwater (4P/9F/4C) and recompute the
    // meal total by SUMMING the items. The AI never reports a free total.
    const ATWATER = (p, f, c) => Math.round(4 * (+p || 0) + 9 * (+f || 0) + 4 * (+c || 0));
    const reconcile = (components) => {
      const items = (Array.isArray(components) ? components : []).map(it => {
        const protein = Math.round(+it.protein || 0), fat = Math.round(+it.fat || 0), carbs = Math.round(+it.carbs || 0);
        const aiKcal = Math.round(+it.kcal || 0);
        const calc = ATWATER(protein, fat, carbs);
        const kcal = (aiKcal > 0 && Math.abs(aiKcal - calc) <= Math.max(25, calc * 0.15)) ? aiKcal : calc;
        return { name: String(it.name || "item").trim(), g: Math.round(+it.g || +it.grams || 0), kcal, protein, fat, carbs };
      });
      const total = items.reduce((a, x) => ({ kcal: a.kcal + x.kcal, protein: a.protein + x.protein, fat: a.fat + x.fat, carbs: a.carbs + x.carbs }), { kcal: 0, protein: 0, fat: 0, carbs: 0 });
      return { items, total };
    };
    // Single-item kcal guard (snack/fruit): fix kcal if it disagrees with macros.
    const fixKcal = (o) => { const g = ATWATER(o.protein, o.fat, o.carbs); if (!(+o.kcal > 0) || Math.abs(+o.kcal - g) > Math.max(25, g * 0.15)) o.kcal = g; return o; };

    // Call the model with a hard timeout so the Worker never hangs indefinitely.
    // `model` defaults to the cheap model; pass MODEL_SMART for macro-critical calls.
    const callAI = async (system, userContent, maxTokens, model) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 25000);
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: model || MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: userContent }] }),
          signal: ctl.signal,
        });
        if (!res.ok) {
          let detail = "";
          try { detail = await res.text(); } catch {}
          return { error: "ai http " + res.status, detail };
        }
        const data = await res.json();
        if (!data.content) return { error: "ai error", detail: data };
        const txt = data.content.map(c => c.text || "").join("").trim();
        return { txt };
      } catch (e) {
        return { error: String(e && e.name === "AbortError" ? "ai timeout" : e) };
      } finally { clearTimeout(t); }
    };

    // Call + parse JSON, with ONE stricter retry if the first reply won't parse.
    // Returns { j } on success, or { error, raw } so the client can show why.
    const aiJSON = async (system, userContent, maxTokens, model) => {
      let r = await callAI(system, userContent, maxTokens, model);
      if (r.error) return r;
      let j = extractJSON(r.txt);
      if (j) return { j };
      r = await callAI(system + " CRITICAL: output ONLY the JSON object — no markdown, no prose, no comments.", userContent, maxTokens + 600, model);
      if (r.error) return r;
      j = extractJSON(r.txt);
      if (j) return { j };
      return { error: "parse", raw: String(r.txt || "").slice(0, 400) };
    };

    // ---- per-phase rulebooks (fallback when no Policy tab policy is sent) ----
    const RULES = {
      loading:
        "PHASE: Loading. The client eats freely to a high calorie target; almost everything is allowed. " +
        "Classify normal whole foods (meat, fish, eggs, dairy, vegetables, fruit, grains, rice, potato, legumes, nuts) as YES. " +
        "LIMITED: nothing special. " +
        "NO only for: added-sugar sweets/desserts/candy, sugary soft drinks and fruit juice, and alcohol. ",
      activation:
        "PHASE: Activation/Transition (a protein-sparing modified fast). Judge per 100g raw. " +
        "Vegetables: YES if net carbs<5 AND sugar<5, no added sugar/oil/starch; LIMITED if net carbs 5-15 OR sugar 5-12 (onion, carrot, beetroot); NO if starchy (potato/corn/peas), added sugar/oil/starch, or dried. " +
        "Fruit by sugar per 100g: YES if sugar<12; NO if sugar>=12 or dried. Allowed fruit (yes): apple, orange, grapefruit, strawberry/berries, lemon, lime, peach, plum. NOT allowed (no): grape, banana, mango, pineapple, cherry, lychee, persimmon, dried fruit. Never mark fruit 'limited'. " +
        "Proteins by fat only: YES fat<5; LIMITED fat 5-10; NO fat>10, or oily fish (salmon/tuna/mackerel/sardine), cured/processed (bacon/sausage/ham), pork, skin-on dark meat. Tofu = YES. Tempeh = LIMITED. Egg whites = YES; whole egg = NO. " +
        "Fried/breaded/oiled/sugared/junk/fast food = NO. Grains/starch (rice/bread/pasta/potato/noodles) = NO. Cheese/milk/whole egg = NO. Nuts/seeds/avocado/oils = NO. ",
      stabilization:
        "PHASE: Stabilization (low-carb keto maintenance). Weight is already lost; hold it. Fat is now the main fuel and is allowed; carbs and sugar are the thing to watch. Judge per 100g raw. " +
        "Proteins: all proteins YES, including fatty cuts, skin-on poultry, pork, plain bacon, whole eggs, oily fish (salmon/tuna/mackerel/trout/sardines), shellfish, tofu, tempeh. NO only if cured or glazed with added sugar (honey ham, sweet-cured bacon, sweet sausage) or breaded/battered. " +
        "Vegetables: above-ground low-carb veg YES (leafy greens, broccoli, cauliflower, cabbage, brussels sprouts, zucchini, asparagus, celery, cucumber, eggplant, green beans, tomato, radish, fennel, mushroom, bell pepper, onion/shallot/garlic in small amounts). LIMITED: carbdense veg (carrot, beetroot, pumpkin). NO: starchy (potato, sweet potato, corn, peas), beans/legumes (lentils, chickpeas, beans), anything with added sugar or dried. " +
        "Fats: YES (olive/avocado/coconut oil, butter, ghee, avocado, olives). LIMITED: nuts, seeds, unsweetened nut butters (carbs add up). " +
        "Dairy: full-fat YES (hard/soft cheese, heavy cream, sour cream, plain full-fat Greek yogurt). NO: milk, sweetened/flavoured yogurt, any low-fat/diet dairy. " +
        "Fruit by sugar/100g: YES if sugar ≤12.5g (berries, apple, watermelon, peach, plum, grapefruit, orange, lemon, lime); LIMITED if sugar 12.6-13.5g; NO if sugar >13.5g, dried fruit, or fruit juice. " +
        "NO: any added sugar, sweets, starch, grains (rice/bread/pasta/noodles), sugary or alcoholic drinks. Cooking in allowed fats is fine. ",
    };

    // Resolve the rulebook: prefer body.policy (from Policy tab via GAS) over hardcoded RULES.
    // Used by estimate and foodcheck. mealbuilder has its own inline resolution.
    const resolveRulebook = (phase) =>
      (typeof body.policy === "string" && body.policy.trim())
        ? ("PHASE RULES: " + body.policy.trim() + " ")
        : RULES[phase];

    try {
      // ---- estimate (meal macros + per-item classification) ----
      if (body.action === "estimate") {
        const rulebook = resolveRulebook(PHASE);
        const sys =
          "You estimate one meal and classify each ingredient for the AEVUM program. " +
          rulebook +
          "Return ONLY strict JSON, no prose, no markdown: " +
          '{"name":string,' +
          '"items":[{"name":string,"type":"protein"|"veg"|"fruit"|"alcohol"|"other","grams":int,"kcal":int,"protein":int,"fat":int,"carbs":int,"verdict":"yes"|"limited"|"no","note":string}]}. ' +
          "Give macros PER ITEM (integer grams; kcal integer) — the meal totals are summed from the items, so do NOT output a meal-level total. " +
          "Each item's numbers MUST satisfy kcal ≈ 4*protein + 9*fat + 4*carbs. name states the assumed portion. If vague, best estimate; never zeros for a real food. " +
          "items: one entry per distinct food (merge seasonings/water/salt into the dish, do not list them separately). grams = the amount in this meal; include any cooking oil/butter as its own item with its real fat. Identify each correctly (banana = fruit, not banana pepper). " +
          "Apply the PHASE rules above to set each item's verdict. type 'other' for anything not protein/veg/fruit/alcohol. " +
          "ALCOHOL: any alcoholic drink is type 'alcohol', verdict 'no', with realistic kcal (spirit ~95-110 per shot, wine ~120-160 per glass, beer ~150). Read the MIXER: a sugary mixer (regular soda/tonic/juice) makes the whole drink NO for sugar; zero-sugar mixers (soda water, Coke Zero) are fine. Any sugary drink or juice is also type 'other', verdict 'no'. " +
          "ACCURACY: for restaurant, fried, takeaway or oily dishes, account for the hidden cooking oil and richer preparation; err toward a realistic (not low) kcal. Do not inflate plain, raw, or clearly home-cooked food. " +
          'note: max 6 words, a cap or reason when limited/no (e.g. "max ~60g", "added sugar", "alcohol"); empty when yes. ' +
          "Keep items concise so the JSON stays complete.";
        const content = [];
        if (body.image) {
          const m = String(body.image).match(/^data:(image\/\w+);base64,(.*)$/);
          if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
        }
        content.push({ type: "text", text: "Meal: " + (body.description || "(see photo)") });
        const pr = await aiJSON(sys, content, 1800, MODEL_SMART);
        if (pr.error) return json(pr, cors);
        const j = pr.j;
        // Reconcile per-item macros (Atwater guard) and SUM them for the top line —
        // the AI never reports a free meal total, so it can't be internally inconsistent.
        const src = Array.isArray(j.items) ? j.items : [];
        const rec = reconcile(src);
        const items = rec.items.map((it, i) => {
          const o = src[i] || {};
          return {
            name: it.name, grams: it.g, kcal: it.kcal, protein: it.protein, fat: it.fat, carbs: it.carbs,
            type: ["protein","veg","fruit","alcohol","other"].includes(o.type) ? o.type : "other",
            verdict: ["yes","limited","no"].includes(o.verdict) ? o.verdict : "limited",
            note: String(o.note || "").trim(),
          };
        });
        return json({ name: j.name || "Meal", kcal: rec.total.kcal, protein: rec.total.protein, fat: rec.total.fat, carbs: rec.total.carbs, items }, cors);
      }

      // ---- foodcheck (Yes/Limited/No) ----
      if (body.action === "foodcheck") {
        const rulebook = resolveRulebook(PHASE);
        const sys =
          "You classify a single food for the AEVUM program. Identify the food correctly (banana = fruit, not banana pepper). " +
          rulebook +
          'Return ONLY strict JSON: {"food":string,"verdict":"yes"|"limited"|"no","reason":string,"cap":string}. ' +
          "reason: max 8 words, plain. cap: for LIMITED a max amount (e.g. \"up to 80g\"); empty for yes/no.";
        const pr = await aiJSON(sys, "Food: " + (body.food || ""), 250);
        if (pr.error) return json(pr, cors);
        const j = pr.j;
        return json({ food: j.food || body.food, verdict: ["yes","limited","no"].includes(j.verdict) ? j.verdict : "limited", reason: j.reason || "", cap: j.cap || "" }, cors);
      }

      // ---- shoplist (phase-independent) ----
      if (body.action === "shoplist") {
        const ingredients = body.ingredients || [];
        if (!ingredients.length) return json({ items: [] }, cors);
        const sys =
          "You build a grocery shopping list from a plan. Input is a mix of exact ingredients and whole dish names or plain foods. " +
          "For exact ingredients, merge duplicates and sum quantities. For a dish name, infer main shopping ingredients. For a plain food, list it directly. " +
          "Merge items named differently (scallion/spring onion). Ignore water, salt, pepper. " +
          "Return ONLY strict JSON: {\"groups\":[{\"category\":string,\"items\":[{\"name\":string,\"qty\":string}]}]}. " +
          "Categories: Protein, Vegetables, Fruit, Pantry/Other. qty = shopping-friendly total. Keep vague amounts approximate.";
        const pr = await aiJSON(sys, "Ingredients across the plan:\n" + ingredients.join("\n"), 1500);
        if (pr.error) return json(pr, cors);
        return json(pr.j, cors);
      }

      // ---- mealbuilder (guided builder AI step) — PHASE-AWARE, DATA-DRIVEN ----
      if (body.action === "mealbuilder") {
        const sub = body.sub || "suggest";
        const phaseName = body.phase || PHASE; // loading | activation | transition | stabilization
        // The app passes the allowed lists (from the Foods tab) + the budget. The Worker
        // has NO hardcoded food knowledge; it only assembles the prompt from what's sent.
        const allowed = body.allowed || {};             // {proteins:[],vegetables:[],fruit:[],fats:[],dairy:[],methods:[],seasonings:[],snacks:[]}
        const targets = body.targets || {};             // {kcal,protein,carbs,fat}
        const rem = body.remaining || {};               // {kcal,protein,carbs,fat}
        const fmtList = (a, label) => (Array.isArray(a) && a.length) ? (`ALLOWED ${label}: ` + a.join(", ") + ".\n") : "";
        const budgetLine =
          `DAILY TARGET: ${targets.kcal != null ? targets.kcal + " kcal, " : ""}${targets.protein != null ? targets.protein + "g protein, " : ""}${targets.carbs != null ? "carbs cap " + targets.carbs + "g, " : ""}${targets.fat != null ? "fat " + targets.fat + "g" : ""}.\n` +
          `REMAINING FOR THIS MEAL: ${rem.kcal != null ? rem.kcal + " kcal, " : ""}${rem.protein != null ? rem.protein + "g protein, " : ""}${rem.carbs != null ? rem.carbs + "g carbs" : ""}.\n`;
        const foodsBlock =
          fmtList(allowed.proteins, "PROTEINS") + fmtList(allowed.vegetables, "VEGETABLES") +
          fmtList(allowed.fruit, "FRUIT") + fmtList(allowed.fats, "FATS") + fmtList(allowed.dairy, "DAIRY") +
          fmtList(allowed.methods, "COOKING METHODS") + fmtList(allowed.seasonings, "SEASONINGS") +
          fmtList(allowed.snacks, "SNACK ITEMS");
        const rulesText = (typeof body.policy === "string" && body.policy.trim()) ? body.policy.trim() : (RULES[phaseName] || "");
        const intro =
          `You are the AEVUM meal builder, building a single meal for the ${phaseName.toUpperCase()} phase. ` +
          (rulesText ? `PHASE RULES (an ingredient is allowed ONLY if it satisfies these): ${rulesText} ` : "") +
          `The ALLOWED lists below are common suggestions, not the full set. ANY ingredient is fine as long as it satisfies the PHASE RULES. ` +
          `If the user requested a specific ingredient that does NOT satisfy the rules, do not use it: put a clear note in flags and substitute a compliant alternative. ` +
          `The meal MUST fit within the REMAINING budget; if tight, reduce portions. Never exceed the carb cap or remaining calories. `;

        if (sub === "suggest") {
          // Parse the protein field: if user typed e.g. "120g air fried prawns",
          // the "120g" is the PORTION SIZE they want, not a protein-macro target.
          // The protein-macro target comes separately in target_g.
          const proteinChoice = body.protein || "(pick from allowed)";
          const proteinTarget = body.target_g || 150;

          const sys = intro +
            "Return ONLY strict JSON:\n" +
            '{"name":string,"components":[{"name":string,"g":int,"kcal":int,"protein":int,"fat":int,"carbs":int}],"cooking_method":string,"seasoning":string,"recipe_steps":[string],"flags":[string]}.\n' +
            "components: ONE row per ingredient (the protein, each vegetable, any added oil/butter, any dairy). g = raw grams used. Give kcal/protein/fat/carbs for THAT ingredient at THAT weight. " +
            "Each row MUST satisfy kcal ≈ 4*protein + 9*fat + 4*carbs. Do NOT output meal totals; they are summed from your components. Always include cooking oil/butter as its own component with its real fat (oil ≈ 9 kcal and 1g fat per gram). " +
            "name: a short appetising meal name. recipe_steps: 3-5 brief steps. " +
            "flags: ONLY include a flag if you substituted an ingredient (rule violation) or could not meet the budget. If the meal is clean and within budget, flags MUST be an empty array. Do NOT add commentary, explanations, or nutritional notes.";
          const userMsg =
            budgetLine + foodsBlock +
            `Build a meal:\n` +
            `- Ingredient choice: ${proteinChoice} (if a weight like "120g" is included, that is the PORTION SIZE of that ingredient to use)\n` +
            `- Cooking method: ${body.method || "(pick from allowed)"}\n` +
            `- Protein source portion: 100-150g raw weight (unless the user specified a different weight above). Do NOT scale up the protein source to hit the protein macro target. Use a normal portion.\n` +
            `- Protein macro target for this meal: ${proteinTarget}g of protein (aspirational, get as close as possible within the portion constraint above, do NOT exceed it)\n` +
            `- Vegetables: 100-200g total from the allowed list (reduce to fit budget)\n` +
            (body.preferences ? `- Preferences: ${body.preferences}\n` : "") +
            (body.exclude ? `- Exclude: ${body.exclude}\n` : "") +
            `Give per-ingredient macros at raw weights.`;
          const pr = await aiJSON(sys, userMsg, 1500, MODEL_SMART);
          if (pr.error) return json(pr, cors);
          const j = pr.j;
          const rec = reconcile(j.components);
          return json({
            name: j.name || "Meal",
            components: rec.items,
            cooking_method: String(j.cooking_method || ""),
            seasoning: String(j.seasoning || ""),
            kcal: rec.total.kcal, protein_total: rec.total.protein, fat: rec.total.fat, carbs: rec.total.carbs,
            recipe_steps: Array.isArray(j.recipe_steps) ? j.recipe_steps : [],
            flags: Array.isArray(j.flags) ? j.flags : [],
          }, cors);
        }

        if (sub === "snack") {
          const sys = intro +
            "Return ONLY strict JSON:\n" +
            '{"name":string,"item":string,"portion_g":int,"kcal":int,"protein":int,"fat":int,"carbs":int,"note":string}.\n' +
            "kcal MUST satisfy kcal ≈ 4*protein + 9*fat + 4*carbs.";
          const userMsg = budgetLine + foodsBlock +
            `Snack item: ${body.item || "(pick from allowed snacks)"}\nSuggest an appropriate portion that fits the remaining budget.`;
          const pr = await aiJSON(sys, userMsg, 500, MODEL_SMART);
          if (pr.error) return json(pr, cors);
          return json(fixKcal(pr.j), cors);
        }

        if (sub === "fruit") {
          const cap = body.cap_g || 100;
          const sys = intro +
            `Fruit max ${cap}g per serving. ` +
            "Return ONLY strict JSON:\n" +
            '{"name":string,"fruit":string,"portion_g":int,"kcal":int,"protein":int,"fat":int,"carbs":int,"note":string}.\n' +
            "kcal MUST satisfy kcal ≈ 4*protein + 9*fat + 4*carbs.";
          const userMsg = budgetLine + fmtList(allowed.fruit, "FRUIT") +
            `Fruit: ${body.fruit || "(pick from allowed fruit)"}\nSuggest a portion (max ${cap}g) that fits the remaining carb budget.`;
          const pr = await aiJSON(sys, userMsg, 400, MODEL_SMART);
          if (pr.error) return json(pr, cors);
          return json(fixKcal(pr.j), cors);
        }

        return json({ error: "unknown mealbuilder sub" }, cors);
      }

      return json({ error: "unknown action" }, cors);
    } catch (e) {
      return json({ error: String(e) }, cors);
    }
  },
};

function json(obj, cors) {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json", ...cors },
  });
}