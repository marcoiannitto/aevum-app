/*  AEVUM tracker backend -- FULL v1.26.0 (reset report endpoint) --
    Changes from v1.25.1:
      - graduation sub=reset: returns profile + data filtered to reset period (days 1..resetDay)
        with compliance + stats computed server-side. Used by report-reset.html.
    Changes from v1.25.0:
      - New register action: self-service signup creates Profile row with program=false, returns unique ID.
      - getProfile now returns program field (true/false).
    Changes from v1.22.1:
      - graduation sub=full now returns compliance[] and stats{} computed server-side.
      - New helpers: dedupRows, findRule_, bandStatus_, isTruthy_, isAlc_, deriveCompliance_, computeStats_.
      - Data rows returned already deduped (one row per day, latest timestamp wins).
      - Dashboard and report consume pre-computed compliance instead of calculating client-side.
    Changes from v1.22.0:
      - graduation sub=full now returns all Data tab columns generically (weight, kcal, protein, fat, carbs, etc.)
        instead of calling getDays() which only returned day + day_json.
    Changes from v1.21.0:
      - getProfile: also returns maintenance_diet from Profile tab.
      - graduation action: accepts diet param (keto/high_protein/balanced) to save maintenance_diet to Profile.
    Changes from v1.19.0:
      - getProfile: returns maintenance_mode from Profile tab.
      - graduation action: accepts mode param to save maintenance_mode to Profile.
      - getRules: maintenance inherits stabilization rules if no explicit rows.
      - getPolicyText: maintenance inherits stabilization policy.
      - syncRow: accepts 'Maintenance' as phase string.
    Changes from v1.18.0:
      - graduation: combined dashboard endpoint (sub=clients, sub=full).
        Added doGet handler so the dashboard can call via GET query params.
    Changes from v1.17.0 (carried in v1.18.0):
      - estimate: now proxies to the Cloudflare Worker (Sonnet, per-item verdicts,
        Atwater guard). GAS fetches the Policy tab rules for the client's phase and
        attaches them as body.policy so the Worker uses them instead of hardcoded rules.
        Response now includes items[] with type/verdict/note alongside top-level macros.
      - foodcheck: now reads the Policy tab rules for the client's phase and injects
        them into the prompt, replacing the old hardcoded activation-only rules.
      - getPolicyText(phase): shared helper that reads the Policy tab and returns the
        rules_text string for a given phase (transition inherits activation).
    One Web App. Routes: estimate, sync, recipes, foodcheck, profile,
    mealplan, getdays, shoplist, settarget, messages, config, savetarget, fitness, mealengine, rules, foods, policy, graduation.

    This is the COMPLETE script. Paste it over everything in
    Extensions --> Apps Script, then Deploy --> Manage deployments -->
    edit the Web app deployment --> New version --> Deploy.

    Requires a Profile tab with a "stab_target_weight" column header.
    Anthropic key lives in Script Properties (ANTHROPIC_KEY), not here.
    Worker URL lives in Script Properties (WORKER_URL), not here.
   ------------------------------------------------------------------ */

const MODEL = 'claude-haiku-4-5-20251001';
const WORKER_URL_DEFAULT = 'https://sweet-fire-a436.marco-iannitto.workers.dev/';
const SHEET_NAME = 'Data';           // tab the data lands in (auto-created)
const HEADERS = ['timestamp','id','name','day','phase','date','weight','waist',
  'serumAM','serumPM','kcal','protein','fat','carbs','water_ml',
  'exercise','exercise_kcal','energy','hunger','sleep','notes','day_json'];

/* ---------- Phase constants (must match index.html) ---------- */
const PH_FIXED_ = {loading:2, transition:3, consolidation:18};
function actDays_(prof){
  var a = parseFloat((prof||{}).activation_days);
  return (a > 0) ? a : 8;
}
function resetDay_(prof){
  return PH_FIXED_.loading + actDays_(prof) + PH_FIXED_.transition;
}

/* ---------- Shared helper: read Policy tab rules_text for a phase ----------
   Returns the rules_text string, or '' if not found. transition inherits activation. */
function getPolicyText(phase){
  const want = String(phase || '').trim().toLowerCase();
  if(!want) return '';
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Policy');
  if(!sh) return '';
  const data = sh.getDataRange().getValues();
  if(data.length < 2) return '';
  const head = data[0].map(h => String(h).trim().toLowerCase());
  const pi = head.indexOf('phase'), ri = head.indexOf('rules_text');
  if(pi < 0 || ri < 0) return '';
  for(let r = 1; r < data.length; r++){
    const p = String(data[r][pi] || '').trim().toLowerCase();
    if(p === want) return String(data[r][ri] || '').trim();
  }
  // transition inherits activation; maintenance inherits stabilization
  const fallback = want === 'transition' ? 'activation' : (want === 'maintenance' ? 'stabilization' : null);
  if(fallback){
    for(let r = 1; r < data.length; r++){
      const p = String(data[r][pi] || '').trim().toLowerCase();
      if(p === fallback) return String(data[r][ri] || '').trim();
    }
  }
  return '';
}

/* ---------- Worker URL helper ---------- */
function getWorkerUrl(){
  return PropertiesService.getScriptProperties().getProperty('WORKER_URL') || WORKER_URL_DEFAULT;
}

/* ---------- GET handler (dashboard uses GET for graduation route) ---------- */
function doGet(e){
  try{
    const p = e.parameter || {};
    if(p.action === 'graduation') return json(graduation(p));
    return json({error:'unknown GET action'});
  }catch(err){
    return json({error:String(err)});
  }
}

function doPost(e){
  try{
    const body = JSON.parse(e.postData.contents);
    if(body.action === 'estimate')  return json(estimateMeal(body));
    if(body.action === 'sync')      return json(syncRow(body));
    if(body.action === 'recipes')   return json(getRecipes());
    if(body.action === 'foodcheck') return json(foodCheck(body));
    if(body.action === 'profile')   return json(getProfile(body));
    if(body.action === 'mealplan')  return json(getMealPlan(body));
    if(body.action === 'getdays')   return json(getDays(body));
    if(body.action === 'shoplist')  return json(shopList(body));
    if(body.action === 'settarget') return json(setStabTarget(body));
    if(body.action === 'messages')  return json(getMessages());
    if(body.action === 'config')    return json(getConfig());
    if(body.action === 'savetarget')return json(saveTargetRow(body));
    if(body.action === 'fitness')   return json(getFitness());
    if(body.action === 'mealengine') return json(mealEngine(body));
    if(body.action === 'rules')      return json(getRules(body));
    if(body.action === 'foods')      return json(getFoods(body));
    if(body.action === 'policy')     return json(getPolicy(body));
    if(body.action === 'graduation') return json(graduation(body));
    if(body.action === 'register')  return json(registerUser(body));
    return json({error:'unknown action'});
  }catch(err){
    return json({error:String(err)});
  }
}

/* ---------- Graduation: dashboard combined endpoint ----------
   sub=clients: list all profiles (id + name).
   sub=full:    profile + all day rows + rules for one client.
   sub=reset:   profile + day rows up to resetDay + rules/compliance/stats (reset report). */
function graduation(params){
  const sub = String(params.sub || '').trim();

  if(sub === 'clients'){
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName('Profile');
    if(!sh) return {clients:[]};
    const data = sh.getDataRange().getValues();
    if(data.length < 2) return {clients:[]};
    const head = data[0].map(h => String(h).trim().toLowerCase());
    const iId = head.indexOf('id'), iName = head.indexOf('name');
    const out = [];
    for(let r = 1; r < data.length; r++){
      const uid = String(data[r][iId] || '').trim();
      if(!uid) continue;
      out.push({id: uid.toLowerCase(), name: iName >= 0 ? String(data[r][iName] || uid) : uid});
    }
    return {clients: out};
  }

  /* --- sub=full or sub=reset: shared data-fetch logic --- */
  if(sub === 'full' || sub === 'reset'){
    const id = String(params.id || '').trim().toLowerCase();
    if(!id) return {error:'no id'};
    const prof = getProfile({id: id});
    const rulesResp = getRules({id: id});
    /* Read ALL Data tab columns generically (not just day+day_json) */
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const dSh = ss.getSheetByName(SHEET_NAME);
    const dataRows = [];
    if(dSh){
      const raw = dSh.getDataRange().getValues();
      if(raw.length >= 2){
        const head = raw[0].map(h => String(h).trim().toLowerCase());
        const iId = head.indexOf('id');
        for(let r = 1; r < raw.length; r++){
          if(String(raw[r][iId] || '').toLowerCase() !== id) continue;
          const row = {};
          for(let c = 0; c < head.length; c++){
            if(head[c] && head[c] !== 'id') row[head[c]] = raw[r][c];
          }
          dataRows.push(row);
        }
      }
    }
    var model = rulesResp.model || 'buckets';
    var rules = rulesResp.rules || [];
    var deduped = dedupRows_(dataRows);

    /* For sub=reset, filter data to days 1..resetDay */
    if(sub === 'reset'){
      var rd = resetDay_(prof.profile || {});
      deduped = deduped.filter(function(r){ return (+r.day || 0) <= rd; });
    }

    var compliance = deriveCompliance_(deduped, rules, model);
    var stats = computeStats_(deduped, compliance);
    return {
      profile: prof.profile,
      model: model,
      data: deduped,
      rules: rules,
      compliance: compliance,
      stats: stats
    };
  }

  // save maintenance mode + diet selection
  const mode = String(params.mode || '').trim().toLowerCase();
  const diet = String(params.diet || '').trim().toLowerCase();
  if((mode || diet) && !sub){
    const id = String(params.id || '').trim().toLowerCase();
    if(!id) return {error:'no id'};
    if(mode && mode !== 'maintain' && mode !== 'cut') return {error:'invalid mode'};
    if(diet && diet !== 'keto' && diet !== 'high_protein' && diet !== 'balanced') return {error:'invalid diet'};
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName('Profile');
    if(!sh) return {error:'no Profile sheet'};
    const data = sh.getDataRange().getValues();
    const head = data[0].map(h => String(h).trim().toLowerCase());
    let iId = head.indexOf('id');
    // ensure maintenance_mode column
    let iMode = head.indexOf('maintenance_mode');
    if(iMode < 0 && mode){
      iMode = head.length;
      sh.getRange(1, iMode + 1).setValue('maintenance_mode');
      head.push('maintenance_mode');
    }
    // ensure maintenance_diet column
    let iDiet = head.indexOf('maintenance_diet');
    if(iDiet < 0 && diet){
      iDiet = head.length;
      sh.getRange(1, iDiet + 1).setValue('maintenance_diet');
      head.push('maintenance_diet');
    }
    for(let r = 1; r < data.length; r++){
      if(String(data[r][iId] || '').trim().toLowerCase() === id){
        if(mode && iMode >= 0) sh.getRange(r + 1, iMode + 1).setValue(mode);
        if(diet && iDiet >= 0) sh.getRange(r + 1, iDiet + 1).setValue(diet);
        return {ok:true, mode:mode||'', diet:diet||''};
      }
    }
    return {error:'id not found'};
  }

  return {error:'unknown graduation sub: ' + sub};
}

/* ---------- Shopping list: consolidate ingredients via AI ---------- */
function shopList(body){
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_KEY');
  if(!key) return {error:'no key set'};
  const ingredients = body.ingredients || []; // array of raw ingredient strings
  if(!ingredients.length) return {items:[]};

  const sys =
    'You build a grocery shopping list from a plan. The input is a mix of exact ingredients '+
    '(e.g. "100g chicken breast") and whole dish names (e.g. "Chicken Parmigiana", "apple"). '+
    'For exact ingredients, merge duplicates and sum quantities. '+
    'For a whole dish name, infer its main shopping ingredients. For a plain food like "apple", list it directly. '+
    'Merge items named differently (scallion/spring onion). Ignore water, salt, pepper. '+
    'Return ONLY strict JSON, no prose: '+
    '{"groups":[{"category":string,"items":[{"name":string,"qty":string}]}]}. '+
    'Categories: Protein, Vegetables, Fruit, Pantry/Other. '+
    'qty = a shopping-friendly total (e.g. "500g", "5 cloves", "6 units"). Keep vague amounts approximate.';

  const payload={model:MODEL,max_tokens:1200,system:sys,
    messages:[{role:'user',content:'Ingredients across the plan:\n'+ingredients.join('\n')}]};
  const res=UrlFetchApp.fetch('https://api.anthropic.com/v1/messages',{
    method:'post',contentType:'application/json',
    headers:{'x-api-key':key,'anthropic-version':'2023-06-01'},
    payload:JSON.stringify(payload),muteHttpExceptions:true});
  const data=JSON.parse(res.getContentText());
  if(!data.content) return {error:'ai error',detail:data};
  let txt=data.content.map(c=>c.text||'').join('').trim().replace(/```json|```/g,'').trim();
  try{ return JSON.parse(txt); }catch(e){ return {error:'parse',raw:txt}; }
}

/* ---------- Get all day rows for one id (multi-device restore) ---------- */
function getDays(body){
  const id=String(body.id||'').toLowerCase();
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sh=ss.getSheetByName(SHEET_NAME);
  if(!sh) return {days:[]};
  const data=sh.getDataRange().getValues();
  if(data.length<2) return {days:[]};
  const head=data[0].map(h=>String(h).trim());
  const iId=head.indexOf('id'), iDay=head.indexOf('day'), iJson=head.indexOf('day_json');
  const out=[];
  for(let r=1;r<data.length;r++){
    if(String(data[r][iId]).toLowerCase()!==id) continue;
    out.push({day:+data[r][iDay]||0, day_json: iJson>=0?String(data[r][iJson]||''):''});
  }
  return {days:out};
}

/* ---------- Meal Plan: read one person's plan from MealPlan tab ---------- */
function getMealPlan(body){
  const id=String(body.id||'').toLowerCase();
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sh=ss.getSheetByName('MealPlan');
  if(!sh) return {plan:[]};
  const data=sh.getDataRange().getValues();
  if(data.length<2) return {plan:[]};
  const head=data[0].map(h=>String(h).trim().toLowerCase());
  const idx=n=>head.indexOf(n);
  const out=[];
  for(let r=1;r<data.length;r++){
    if(String(data[r][idx('id')]).toLowerCase()!==id) continue;
    out.push({
      day:+data[r][idx('day')]||0,
      meal:data[r][idx('meal')]||'',
      recipe:data[r][idx('recipe')]||'',
      kcal:+data[r][idx('kcal')]||0,
      protein:+data[r][idx('protein')]||0,
      fat:+data[r][idx('fat')]||0,
      carbs:+data[r][idx('carbs')]||0
    });
  }
  return {plan:out};
}

/* ---------- Register: self-service signup for free users (v1.25.0) ---------- */
function registerUser(body){
  const name = String(body.name||'').trim();
  if(!name) return {error:'name required'};
  const sex = String(body.sex||'').toLowerCase();
  if(sex!=='m'&&sex!=='f') return {error:'sex must be m or f'};
  const age = parseInt(body.age)||0;
  const height = parseFloat(body.height)||0;
  const weight = parseFloat(body.weight)||0;
  const act = parseFloat(body.act)||1.55;
  const target_kg = parseFloat(body.target_kg)||null;
  if(!age||!height||!weight) return {error:'age, height, weight required'};

  // Mifflin TDEE
  var s = (sex==='m') ? 5 : -161;
  var tdee = Math.round((10*weight + 6.25*height - 5*age + s) * act);

  // Generate unique ID: first name + 4 random chars
  const base = name.toLowerCase().replace(/[^a-z]/g,'').slice(0,8);
  const rnd = Math.random().toString(36).slice(2,6);
  const id = base + '_' + rnd;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('Profile');
  if(!sh){ sh = ss.insertSheet('Profile'); sh.appendRow(['id','name','sex','age','height','start_weight','activity','target_kg','program']); }

  const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(h=>String(h).trim().toLowerCase());

  // Ensure program and current_target_kcal columns exist
  var headArr = head.slice();
  let progCol = headArr.indexOf('program');
  if(progCol<0){ sh.getRange(1, headArr.length+1).setValue('program'); headArr.push('program'); progCol = headArr.length-1; }
  let tgtCol = headArr.indexOf('current_target_kcal');
  if(tgtCol<0){ sh.getRange(1, headArr.length+1).setValue('current_target_kcal'); headArr.push('current_target_kcal'); tgtCol = headArr.length-1; }

  // Build row matching headers
  const row = new Array(headArr.length).fill('');
  function setCol(colName, val){ const i=headArr.indexOf(colName); if(i>=0) row[i]=val; }
  setCol('id', id);
  setCol('name', name);
  setCol('sex', sex);
  setCol('age', age);
  setCol('height', height);
  setCol('start_weight', weight);
  setCol('activity', act);
  setCol('target_kg', target_kg);
  row[progCol] = false;
  row[tgtCol] = tdee;

  sh.appendRow(row);
  return {id: id, program: false, current_target_kcal: tdee};
}

/* ---------- Profile: read one person's row from Profile tab (v1.8.0) ---------- */
function getProfile(body){
  const id=String(body.id||'').toLowerCase();
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sh=ss.getSheetByName('Profile');
  if(!sh) return {profile:null};
  const data=sh.getDataRange().getValues();
  if(data.length<2) return {profile:null};
  const head=data[0].map(h=>String(h).trim().toLowerCase());
  const idx=n=>head.indexOf(n);
  for(let r=1;r<data.length;r++){
    if(String(data[r][idx('id')]).toLowerCase()===id){
      const g=n=>{const i=idx(n);return i>=0?data[r][i]:'';};
      const sd=g('start_date');
      let sdStr='';
      if(sd instanceof Date){ sdStr=Utilities.formatDate(sd,Session.getScriptTimeZone(),'yyyy-MM-dd'); }
      else if(sd){ sdStr=String(sd); }
      return {profile:{
        id: id,
        name: g('name'),
        target_kg: parseFloat(g('target_kg'))||null,
        start_weight: parseFloat(g('start_weight'))||null,
        start_date: sdStr,
        height: parseFloat(g('height'))||null,
        activation_days: parseFloat(g('activation_days'))||null,
        stab_target_weight: parseFloat(g('stab_target_weight'))||null,
        current_target_kcal: parseFloat(g('current_target_kcal'))||null,
        prev_target_kcal: parseFloat(g('prev_target_kcal'))||null,
        last_review_date: (function(){var d=g('last_review_date');if(d instanceof Date)return Utilities.formatDate(d,Session.getScriptTimeZone(),'yyyy-MM-dd');return d?String(d):'';})(),
        last_change_reason: String(g('last_change_reason')||''),
        maintenance_mode: String(g('maintenance_mode')||''),
        maintenance_diet: String(g('maintenance_diet')||''),
        program: (function(){ var v=g('program'); if(v===true||v==='true'||v==='TRUE') return true; if(v===false||v==='false'||v==='FALSE') return false; return !!g('start_date'); })(),
        notes: g('notes')||''
      }};
    }
  }
  return {profile:null};
}

/* ---------- Stabilization target: write once if not already set (v1.8.0) ---------- */
function setStabTarget(body){
  const id=String(body.id||'').toLowerCase();
  const val=parseFloat(body.stab_target_weight);
  if(!id || !(val>0)) return {error:'bad input'};
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sh=ss.getSheetByName('Profile');
  if(!sh) return {error:'no Profile tab'};
  const data=sh.getDataRange().getValues();
  const head=data[0].map(h=>String(h).trim().toLowerCase());
  let col=head.indexOf('stab_target_weight');
  if(col<0){
    col=head.length;
    sh.getRange(1,col+1).setValue('stab_target_weight');
  }
  const idCol=head.indexOf('id');
  for(let r=1;r<data.length;r++){
    if(String(data[r][idCol]).toLowerCase()===id){
      const cur=parseFloat(data[r][col]);
      if(!(cur>0)) sh.getRange(r+1,col+1).setValue(val);
      return {ok:true};
    }
  }
  return {error:'id not found'};
}

/* ---------- Food check: AEVUM rules from Policy tab --> Yes / Limited / No ---------- */
function foodCheck(body){
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_KEY');
  if(!key) return {error:'no key set'};
  const food = String(body.food||'').trim();
  if(!food) return {error:'no food'};

  const phase = String(body.phase || 'activation').trim().toLowerCase();
  const policy = getPolicyText(phase);

  const rulesBlock = policy
    ? ('PHASE RULES (judge the food against these):\n' + policy + '\n')
    : ('You classify a single food for the AEVUM Activation diet (a protein-sparing modified fast). ' +
       'RULES:\n' +
       'Vegetables & fruit -- by net carbs, sugar, fat: ' +
       'YES if net carbs <5g AND sugar <5g AND fat <3g and no added sugar/oil/starch; ' +
       'LIMITED if net carbs 5-15g OR sugar 5-12g OR fat 3-10g; ' +
       'NO if net carbs >15g OR sugar >12g OR fat >10g, or any added sugar/oil/starch, or dried/dehydrated. ' +
       'Proteins -- by fat only: YES if fat <5g; LIMITED if fat 5-10g; NO if fat >10g, or oily fish (salmon/tuna/mackerel/sardine), or cured/processed (bacon/sausage/ham), or pork, or skin-on dark meat, or tempeh. ' +
       'Anything fried, breaded, oiled, sugared, or a composite junk/fast food = NO. ' +
       'Grains/starch (rice/bread/pasta/potato/noodles) = NO. Dairy cheese = NO. Nuts/seeds/avocado/oils = NO (too fatty). ');

  const sys =
    'You classify a single food for the AEVUM program. ' +
    'Judge the food per 100g, raw. Identify the food correctly (e.g. "banana" is the fruit, not banana pepper). ' +
    'Return ONLY strict JSON, no prose, no markdown: ' +
    '{"food":string,"verdict":"yes"|"limited"|"no","reason":string,"cap":string}. ' +
    rulesBlock +
    'field "food" = the correctly identified food name. ' +
    'field "reason" = max 8 words, plain (e.g. "high fat", "too much sugar", "lean protein"). ' +
    'field "cap" = for LIMITED only, a sensible max amount to stay compliant (e.g. "up to 80g"); empty string for yes/no.';

  const payload={model:MODEL,max_tokens:160,system:sys,messages:[{role:'user',content:'Food: '+food}]};
  const res=UrlFetchApp.fetch('https://api.anthropic.com/v1/messages',{
    method:'post',contentType:'application/json',
    headers:{'x-api-key':key,'anthropic-version':'2023-06-01'},
    payload:JSON.stringify(payload),muteHttpExceptions:true});
  const data=JSON.parse(res.getContentText());
  if(!data.content) return {error:'ai error',detail:data};
  let txt=data.content.map(c=>c.text||'').join('').trim().replace(/```json|```/g,'').trim();
  try{
    const j=JSON.parse(txt);
    return {food:j.food||food,verdict:j.verdict||'limited',reason:j.reason||'',cap:j.cap||''};
  }catch(e){return {error:'parse',raw:txt};}
}

/* ---------- Config: read the Config tab (key,value) so Marco can tune numbers ---------- */
function getConfig(){
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sh=ss.getSheetByName('Config');
  if(!sh) return {config:[]};
  const data=sh.getDataRange().getValues();
  if(data.length<2) return {config:[]};
  const head=data[0].map(h=>String(h).trim().toLowerCase());
  const ki=head.indexOf('key'), vi=head.indexOf('value');
  if(ki<0||vi<0) return {config:[]};
  const out=[];
  for(let r=1;r<data.length;r++){
    const k=String(data[r][ki]||'').trim();
    if(!k) continue;
    out.push({key:k, value:data[r][vi]});
  }
  return {config: out};
}

/* ---------- Adaptive target: write the weekly-review fields to the Profile row ---------- */
function saveTargetRow(body){
  const id=String(body.id||'').toLowerCase();
  if(!id) return {error:'no id'};
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sh=ss.getSheetByName('Profile');
  if(!sh) return {error:'no Profile tab'};
  const data=sh.getDataRange().getValues();
  const head=data[0].map(h=>String(h).trim().toLowerCase());
  const ensureCol=(name)=>{let c=head.indexOf(name);if(c<0){c=head.length;sh.getRange(1,c+1).setValue(name);head.push(name);}return c;};
  const fields={
    current_target_kcal: body.current_target_kcal,
    prev_target_kcal: body.prev_target_kcal,
    last_review_date: body.last_review_date,
    last_change_reason: body.last_change_reason,
    adherence: body.adherence
  };
  const idCol=head.indexOf('id');
  for(let r=1;r<data.length;r++){
    if(String(data[r][idCol]).toLowerCase()===id){
      for(const name in fields){
        if(fields[name]===undefined) continue;
        const c=ensureCol(name);
        sh.getRange(r+1,c+1).setValue(fields[name]);
      }
      return {ok:true};
    }
  }
  return {error:'id not found'};
}

/* ---------- Daily briefing messages: read the Messages tab, return as JSON ----------
   Marco owns this tab. Columns (header row, any order):
   id | trigger | enabled | phase | priority | title | body | badge | frequency
   trigger must be one the app knows (alcohol_yesterday, great_day_yesterday,
   weight_down_small, holding_steady, always, target_changed_up, target_changed_down).
   body may use placeholders {name} {kcal} {old_target} {new_target}. */
function getMessages(){
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sh=ss.getSheetByName('Messages');
  if(!sh) return {messages:[]};
  const data=sh.getDataRange().getValues();
  if(data.length<2) return {messages:[]};
  const head=data[0].map(h=>String(h).trim().toLowerCase());
  const idx=n=>head.indexOf(n);
  const out=[];
  for(let r=1;r<data.length;r++){
    const g=n=>{const i=idx(n);return i>=0?data[r][i]:'';};
    const trig=String(g('trigger')||'').trim();
    if(!trig) continue;
    out.push({
      id: String(g('id')||('m'+r)),
      trigger: trig,
      enabled: String(g('enabled')===''?'yes':g('enabled')).trim(),
      phase: String(g('phase')||'').trim(),
      priority: parseInt(g('priority'))||0,
      title: String(g('title')||''),
      body: String(g('body')||''),
      badge: String(g('badge')||''),
      frequency: String(g('frequency')||'daily').trim()
    });
  }
  return {messages: out};
}

/* ---------- Fitness (item 31): read Movements + Workouts tabs ----------
   Marco owns both tabs. Empty/missing tabs -> app shows a "coming soon" state.
   Movements columns (header row, any order):
     id | name | phase | equipment | video_url | cues | mistake
     phase = "all" or a comma list (loading,activation,stabilization).
     video_url = full URL to the .mp4 (spaces allowed; the app encodes them).
     cues = one or more coaching cues separated by "||" (no fixed limit).
   Workouts columns (one row per movement in a routine; rows share workout_id):
     workout_id | workout_name | phase | duration_min | order | movement_id | sets | reps | rest_sec
     reps = 0 means a timed/hold movement (no rep count shown).
   NO intensity cues here -- routines are designed to keep clients in the target
   zone; the app never shows Z2/RPE/BPM to users. */
function getFitness(){
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const mv=readTab(ss,'Movements',['id','name','phase','equipment','video_url','cues','mistake']);
  const wk=readTab(ss,'Workouts',['workout_id','workout_name','phase','duration_min','order','movement_id','sets','reps','rest_sec']);
  return {movements: mv, workouts: wk};
}
function readTab(ss,tabName,cols){
  const sh=ss.getSheetByName(tabName);
  if(!sh) return [];
  const data=sh.getDataRange().getValues();
  if(data.length<2) return [];
  const head=data[0].map(h=>String(h).trim().toLowerCase());
  const idx=n=>head.indexOf(n);
  const key=cols[0];
  const out=[];
  for(let r=1;r<data.length;r++){
    const g=n=>{const i=idx(n);return i>=0?data[r][i]:'';};
    if(String(g(key)||'').trim()==='') continue;
    const o={};
    cols.forEach(c=>{o[c]=g(c);});
    out.push(o);
  }
  return out;
}

/* ---------- Recipes: read the Recipes tab, return as JSON ---------- */
function getRecipes(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Recipes');
  if(!sh) return {recipes:[]};
  const data = sh.getDataRange().getValues();
  if(data.length < 2) return {recipes:[]};
  const head = data[0].map(h=>String(h).trim());
  const idx = n => head.indexOf(n);
  const out = [];
  for(let r=1; r<data.length; r++){
    const row = data[r];
    if(!row[idx('name')]) continue;
    out.push({
      name: row[idx('name')],
      protein: row[idx('protein')],
      cuisine: row[idx('cuisine')],
      phase: idx('phase')>=0 ? String(row[idx('phase')]||'') : '',
      kcal: +row[idx('kcal')]||0,
      protein_g: +row[idx('protein_g')]||0,
      fat_g: +row[idx('fat_g')]||0,
      carbs_g: +row[idx('carbs_g')]||0,
      ingredients: String(row[idx('ingredients')]||'').split('||').map(s=>s.trim()).filter(Boolean),
      steps: String(row[idx('steps')]||'').split('||').map(s=>s.trim()).filter(Boolean)
    });
  }
  return {recipes: out};
}

/* ---------- AI meal estimate: proxy to Worker (Sonnet + Atwater + per-item verdicts) ----------
   Fetches the Policy tab rules for the client's phase and sends them to the Worker
   so the AI judges ingredients against the editable rules, not hardcoded ones. */
function estimateMeal(body){
  const url = getWorkerUrl();
  const phase = String(body.phase || 'activation').trim().toLowerCase();
  const policy = getPolicyText(phase);

  const workerBody = {
    action: 'estimate',
    phase: phase,
    description: body.description || '',
    policy: policy
  };
  if(body.image) workerBody.image = body.image;

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(workerBody),
    muteHttpExceptions: true
  });

  try {
    const data = JSON.parse(res.getContentText());
    if(data.error) return {error: data.error, detail: data.detail || ''};
    return data;
  } catch(e) {
    return {error: 'worker parse error', raw: res.getContentText().substring(0, 500)};
  }
}

/* ---------- Sheet sync (upsert one row per id+day) ---------- */
function syncRow(b){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if(!sh){ sh = ss.insertSheet(SHEET_NAME); sh.appendRow(HEADERS); }
  if(sh.getLastRow() === 0) sh.appendRow(HEADERS);

  const row = [
    new Date(), b.id||'', b.name||'', b.day||'', b.phase||'', b.date||'',
    b.weight||'', b.waist||'', b.serumAM?'yes':'', b.serumPM?'yes':'',
    b.kcal||0, b.protein||0, b.fat||0, b.carbs||0, b.water_ml||0,
    b.exercise||'', b.exercise_kcal||0, b.energy||'', b.hunger||'', b.sleep||'', b.notes||'', b.day_json||''
  ];

  const data = sh.getDataRange().getValues();
  let found = -1;
  for(let r=1; r<data.length; r++){
    if(String(data[r][1])===String(b.id) && String(data[r][3])===String(b.day)){ found=r+1; break; }
  }
  if(found>0) sh.getRange(found,1,1,row.length).setValues([row]);
  else sh.appendRow(row);

  return {ok:true};
}

/* ═══════════════════════════════════════════════════════════════════════
   MEAL ENGINE -- Guided Builder support (v0.1.0 MVP)
   These formulas differ from the master brief. This is a test build.
   DO NOT update the master file.
   ═══════════════════════════════════════════════════════════════════════ */

const ME = {
  /* ---- Macro formulas ---- */
  IBW_MEN:   (h) => 50 + 0.9 * (h - 152),
  IBW_WOMEN: (h) => 45.5 + 0.9 * (h - 152),
  P_PER_KG: 1.5,                       // g protein per kg IBW
  C_DAILY:  50,                         // g carbs (30 if body_weight < 60)
  C_LOW_BW: 30,                         // carbs for <60 kg
  C_BW_THRESHOLD: 60,                   // kg threshold
  F_DAILY:  0,                          // Activation: zero added fat

  /* ---- Supplement (AEVUM_ITALY), partial; pending nutritionist ---- */
  SUPPLEMENT: {
    name: 'AEVUM_ITALY',
    protein_g: 28,
    kcal: 112,                          // 28g x 4 kcal/g (protein only, pending full data)
    fat_g: 0,
    carbs_g: 0
  },

  /* ---- Meal structure (Activation, 16/8 IF) ---- */
  EATING_WINDOW_H: 8,                  // 8-hour eating window
  FASTING_H: 16,
  SLOTS: ['Meal 1', 'Meal 2', 'Snack 1', 'Snack 2', 'Fruit'],
  MAIN_MEAL_SLOTS: ['Meal 1', 'Meal 2'],
  SNACK_SLOTS: ['Snack 1', 'Snack 2'],
  FRUIT_SLOTS: ['Fruit'],

  /* ---- Portion caps ---- */
  VEG_MIN_G: 100,
  VEG_MAX_G: 200,
  FRUIT_CAP_G: 100,

  /* ---- Allowed ingredients (the "database") ---- */
  PROTEINS: {
    allowed: ['chicken breast','turkey breast','cod','sea bass','sea bream',
              'sole','hake','prawns','shrimp','squid','octopus','cuttlefish',
              'clams','mussels','egg whites','tofu','veal (lean)','rabbit',
              'horse meat','bresaola'],
    limited: ['turkey thigh','swordfish','tuna (fresh)','tempeh',
              'fesa di tacchino','prosciutto crudo (no fat)','prosciutto cotto (no fat)'],
    not_allowed: ['salmon','mackerel','sardines','pork','bacon','sausage',
                  'ham','whole eggs','cheese','any cured/processed meat with fat']
  },
  VEGETABLES: {
    allowed: ['zucchini','spinach','lettuce','rocket/arugula','kale','chard',
              'broccoli','cauliflower','asparagus','green beans','cucumber',
              'celery','fennel','mushrooms','bell peppers','tomatoes','radish',
              'eggplant','artichoke','chicory','radicchio','cabbage',
              'brussels sprouts','endive'],
    limited: ['onion','carrot','beetroot','pumpkin'],
    not_allowed: ['potato','sweet potato','corn','peas','beans','lentils',
                  'chickpeas','any dried/dehydrated vegetable']
  },
  FRUIT: {
    allowed: ['apple','orange','grapefruit','strawberries','blueberries',
              'raspberries','blackberries','lemon','lime','peach','plum'],
    not_allowed: ['banana','grape','mango','pineapple','cherry','lychee',
                  'persimmon','watermelon','melon','dried fruit','fruit juice']
  },
  COOKING_METHODS: {
    allowed: ['grilled','boiled','steamed','baked','poached','raw',
              'air-fried (no oil)','microwave'],
    not_allowed: ['fried','deep-fried','sauteed in oil','breaded','battered',
                  'pan-fried with fat']
  },
  SEASONINGS: {
    allowed: ['salt','pepper','herbs (fresh/dried)','spices','lemon juice',
              'lime juice','vinegar','garlic','chilli','mustard (no sugar)',
              'soy sauce (small amount)'],
    not_allowed: ['oil','butter','mayo','cream','sugar','honey','ketchup',
                  'BBQ sauce','any sauce with fat or sugar']
  },
  SNACK_ITEMS: {
    allowed: ['fat-free greek yogurt','dark chocolate (>85%)','bresaola',
              'prosciutto crudo (no fat)','prosciutto cotto (no fat)',
              'fesa di tacchino'],
    rules: 'Cured meat snacks limited to 1-2 times per week for health.'
  },

  /* ---- Generation ---- */
  PLAN_DAYS: 5,                         // default generation span
  ACTIVATION_DEFAULT_DAYS: 8
};

/* ---------- Macro calculator ---------- */
function mealEngineCalc(body) {
  const sex    = String(body.sex || 'm').toLowerCase();
  const height = parseFloat(body.height);
  const weight = parseFloat(body.weight);
  const age    = parseInt(body.age, 10);
  const actDaysVal = parseInt(body.activation_days, 10) || ME.ACTIVATION_DEFAULT_DAYS;

  if (!height || !weight) return { error: 'height and weight required' };

  const ibw = sex === 'f' ? ME.IBW_WOMEN(height) : ME.IBW_MEN(height);
  const p_daily = ME.P_PER_KG * ibw;
  const p_food  = p_daily - ME.SUPPLEMENT.protein_g;
  const c_daily = weight < ME.C_BW_THRESHOLD ? ME.C_LOW_BW : ME.C_DAILY;
  const f_daily = ME.F_DAILY;

  // kcal estimate: 4xP_food + 4xC + 9xF + supplement.kcal
  const kcal_food = 4 * p_food + 4 * c_daily + 9 * f_daily;
  const kcal_total = kcal_food + ME.SUPPLEMENT.kcal;

  // Per-meal budget (2 main meals)
  const meals_count = ME.MAIN_MEAL_SLOTS.length;
  const p_per_meal  = Math.round(p_food / meals_count);
  const c_per_meal  = Math.round(c_daily / meals_count);

  return {
    ibw: Math.round(ibw * 10) / 10,
    p_daily: Math.round(p_daily),
    p_food: Math.round(p_food),
    c_daily: c_daily,
    f_daily: f_daily,
    kcal_estimate: Math.round(kcal_total),
    supplement: ME.SUPPLEMENT,
    per_meal: { protein_g: p_per_meal, carbs_g: c_per_meal, fat_g: 0 },
    activation_days: actDaysVal,
    slots: ME.SLOTS
  };
}

/* ---------- Route: mealengine ---------- */
function mealEngine(body) {
  const sub = String(body.sub || '');

  // sub=calc: return macro targets
  if (sub === 'calc') {
    return mealEngineCalc(body);
  }

  // sub=config: return full ingredient config (for frontend display)
  if (sub === 'config') {
    return {
      proteins: ME.PROTEINS,
      vegetables: ME.VEGETABLES,
      fruit: ME.FRUIT,
      cooking_methods: ME.COOKING_METHODS,
      seasonings: ME.SEASONINGS,
      snack_items: ME.SNACK_ITEMS,
      supplement: ME.SUPPLEMENT,
      slots: ME.SLOTS,
      fruit_cap_g: ME.FRUIT_CAP_G,
      veg_range: [ME.VEG_MIN_G, ME.VEG_MAX_G],
      plan_days: ME.PLAN_DAYS
    };
  }

  // sub=validate: check a proposed meal against hard rules
  if (sub === 'validate') {
    return validateMeal(body);
  }

  // sub=save: write completed plan rows to MealPlan tab
  if (sub === 'save') {
    return saveMealPlan(body);
  }

  // sub=users: list all user IDs and names from Profile tab
  if (sub === 'users') {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName('Profile');
    if (!sh) return { users: [] };
    const data = sh.getDataRange().getValues();
    if (data.length < 2) return { users: [] };
    const head = data[0].map(h => String(h).trim().toLowerCase());
    const iId = head.indexOf('id'), iName = head.indexOf('name');
    const out = [];
    for (let r = 1; r < data.length; r++) {
      const uid = String(data[r][iId] || '').trim();
      if (!uid) continue;
      out.push({ id: uid.toLowerCase(), name: iName >= 0 ? String(data[r][iName] || uid) : uid });
    }
    return { users: out };
  }

  return { error: 'unknown mealengine sub: ' + sub };
}

/* ---------- Validate a single meal against hard rules ---------- */
function validateMeal(body) {
  const flags = [];
  const items = body.items || [];

  items.forEach(item => {
    const name = String(item.name || '').toLowerCase();
    const type = String(item.type || '');

    if (type === 'protein') {
      if (ME.PROTEINS.not_allowed.some(p => name.includes(p.toLowerCase()))) {
        flags.push({ item: item.name, issue: 'not allowed in Activation' });
      }
    }
    if (type === 'vegetable') {
      if (ME.VEGETABLES.not_allowed.some(v => name.includes(v.toLowerCase()))) {
        flags.push({ item: item.name, issue: 'starchy/not allowed' });
      }
    }
    if (type === 'fruit') {
      if (ME.FRUIT.not_allowed.some(f => name.includes(f.toLowerCase()))) {
        flags.push({ item: item.name, issue: 'too much sugar' });
      }
      if ((+item.grams || 0) > ME.FRUIT_CAP_G) {
        flags.push({ item: item.name, issue: 'over ' + ME.FRUIT_CAP_G + 'g fruit cap' });
      }
    }
    if (item.cooking_method) {
      const cm = String(item.cooking_method).toLowerCase();
      if (ME.COOKING_METHODS.not_allowed.some(m => cm.includes(m.toLowerCase()))) {
        flags.push({ item: item.name, issue: 'cooking method not allowed (uses fat)' });
      }
    }
  });

  // Macro checks
  const macros = body.macros || {};
  if ((+macros.fat || 0) > 0) {
    flags.push({ item: 'total', issue: 'Activation = zero added fat' });
  }

  return { valid: flags.length === 0, flags };
}

/* ---------- Save meal plan rows to MealPlan tab ---------- */
function saveMealPlan(body) {
  const id = String(body.id || '').toLowerCase();
  const rows = body.rows || []; // [{day, meal, recipe, kcal, protein, fat, carbs}]
  if (!id || !rows.length) return { error: 'id and rows required' };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('MealPlan');
  if (!sh) {
    sh = ss.insertSheet('MealPlan');
    sh.appendRow(['id', 'day', 'meal', 'recipe', 'kcal', 'protein', 'fat', 'carbs']);
  }

  // ADDITIVE (append-only): we do NOT delete the day's existing rows, so manual sheet
  // edits are never clobbered. The meal-builder only sends meals it hasn't saved yet.
  rows.forEach(r => {
    sh.appendRow([id, +r.day, r.meal || '', r.recipe || '',
      Math.round(+r.kcal || 0), Math.round(+r.protein || 0),
      Math.round(+r.fat || 0), Math.round(+r.carbs || 0)]);
  });

  return { ok: true, saved: rows.length };
}

/* ---------- Rules: centralized targets/thresholds (see aevum-rules-reference.md) ----------
   Reads the "Rules" tab + the client's Profile, returns thresholds resolved for that client:
   grams computed from target weight for per_kg_target_weight rows; adaptive_kcal left to the
   tracker; rows filtered to the client's activation_model. transition inherits activation. */
function getRules(body){
  const id = String(body.id || '').toLowerCase();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // client's model + target weight from Profile
  let model = 'buckets', targetWeight = null;
  const prof = ss.getSheetByName('Profile');
  if (prof && id) {
    const pd = prof.getDataRange().getValues();
    const ph = pd[0].map(h => String(h).trim().toLowerCase());
    const pi = n => ph.indexOf(n);
    for (let r = 1; r < pd.length; r++) {
      if (String(pd[r][pi('id')]).toLowerCase() !== id) continue;
      const g = n => { const i = pi(n); return i >= 0 ? pd[r][i] : ''; };
      const m = String(g('activation_model') || '').trim().toLowerCase();
      if (m === 'macros' || m === 'buckets') model = m;
      targetWeight = parseFloat(g('stab_target_weight')) || parseFloat(g('target_kg')) || parseFloat(g('start_weight')) || null;
      break;
    }
  }

  const sh = ss.getSheetByName('Rules');
  if (!sh) return { model: model, rules: [] };
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { model: model, rules: [] };
  const head = data[0].map(h => String(h).trim().toLowerCase());
  const idx = n => head.indexOf(n);
  const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };

  const out = [];
  for (let r = 1; r < data.length; r++) {
    const g = n => { const i = idx(n); return i >= 0 ? data[r][i] : ''; };
    const phase = String(g('phase') || '').trim().toLowerCase();
    const rowModel = String(g('model') || 'all').trim().toLowerCase();
    const metric = String(g('metric') || '').trim().toLowerCase();
    if (!phase || !metric) continue;
    // maintenance diet types (keto/high_protein/balanced) pass through regardless of activation_model
    const maintDiets = ['keto','high_protein','balanced'];
    if (rowModel !== 'all' && rowModel !== model && !maintDiets.includes(rowModel)) continue;

    const basis = String(g('basis') || 'fixed').trim().toLowerCase();
    const gated = String(g('gated') || '').trim().toLowerCase() !== 'no';
    const unit = String(g('unit') || '').trim();
    const raw = { value: num(g('value')), green_lo: num(g('green_lo')), green_hi: num(g('green_hi')), amber_lo: num(g('amber_lo')), amber_hi: num(g('amber_hi')) };

    let target = raw.value, bands = { green_lo: raw.green_lo, green_hi: raw.green_hi, amber_lo: raw.amber_lo, amber_hi: raw.amber_hi };
    if (basis === 'per_kg_target_weight') {
      const w = targetWeight || 0;
      const mult = x => (x == null || !w) ? null : Math.round(x * w);
      target = mult(raw.value);
      bands = { green_lo: mult(raw.green_lo), green_hi: mult(raw.green_hi), amber_lo: mult(raw.amber_lo), amber_hi: mult(raw.amber_hi) };
    } else if (basis === 'adaptive_kcal') {
      target = null; // tracker fills from its adaptive engine
    }
    // pct_of_kcal: pass raw percentages through -- tracker resolves to grams client-side

    out.push({ phase: phase, model: rowModel, metric: metric, basis: basis, target: target,
      green_lo: bands.green_lo, green_hi: bands.green_hi, amber_lo: bands.amber_lo, amber_hi: bands.amber_hi,
      gated: gated, unit: unit });
  }

  // transition inherits activation unless explicit transition rows exist
  if (!out.some(x => x.phase === 'transition')) {
    out.filter(x => x.phase === 'activation').forEach(x => out.push(Object.assign({}, x, { phase: 'transition' })));
  }
  // maintenance inherits stabilization unless explicit maintenance rows exist
  if (!out.some(x => x.phase === 'maintenance')) {
    out.filter(x => x.phase === 'stabilization').forEach(x => out.push(Object.assign({}, x, { phase: 'maintenance' })));
  }

  return { model: model, target_weight: targetWeight, rules: out };
}

/* ---------- Foods: editable allowed-food lists (phase,category,item,verdict,cap_g,note) ----------
   transition inherits activation. Optional body.phase filters the result. */
function getFoods(body){
  const want = String(body.phase || '').trim().toLowerCase();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Foods');
  if (!sh) return { foods: [] };
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { foods: [] };
  const head = data[0].map(h => String(h).trim().toLowerCase());
  const idx = n => head.indexOf(n);
  const out = [];
  for (let r = 1; r < data.length; r++) {
    const g = n => { const i = idx(n); return i >= 0 ? data[r][i] : ''; };
    let phase = String(g('phase') || '').trim().toLowerCase();
    const item = String(g('item') || '').trim();
    if (!phase || !item) continue;
    out.push({
      phase: phase,
      category: String(g('category') || '').trim().toLowerCase(),
      subcategory: String(g('subcategory') || '').trim().toLowerCase(),
      item: item,
      verdict: String(g('verdict') || 'yes').trim().toLowerCase(),
      cap_g: (function(){ const n = parseFloat(g('cap_g')); return isNaN(n) ? null : n; })(),
      note: String(g('note') || '').trim()
    });
  }
  // transition inherits activation
  if (!out.some(x => x.phase === 'transition')) {
    out.filter(x => x.phase === 'activation').forEach(x => out.push(Object.assign({}, x, { phase: 'transition' })));
  }
  const res = want ? out.filter(x => x.phase === want) : out;
  return { foods: res };
}

/* ---------- Policy: editable per-phase food rules the AI judges against ----------
   Tab "Policy": phase | rules_text. transition inherits activation. Optional body.phase filters. */
function getPolicy(body){
  const want = String(body.phase || '').trim().toLowerCase();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Policy');
  if (!sh) return { policy: [] };
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { policy: [] };
  const head = data[0].map(h => String(h).trim().toLowerCase());
  const pi = head.indexOf('phase'), ri = head.indexOf('rules_text');
  if (pi < 0 || ri < 0) return { policy: [] };
  const out = [];
  for (let r = 1; r < data.length; r++) {
    const phase = String(data[r][pi] || '').trim().toLowerCase();
    const text = String(data[r][ri] || '').trim();
    if (!phase || !text) continue;
    out.push({ phase: phase, rules_text: text });
  }
  if (!out.some(x => x.phase === 'transition')) {
    const act = out.find(x => x.phase === 'activation');
    if (act) out.push({ phase: 'transition', rules_text: act.rules_text });
  }
  const res = want ? out.filter(x => x.phase === want) : out;
  return { policy: res };
}

/* ---------- Compliance engine (server-side, v1.23.0) ---------- */

var ALC_ = ['alcohol','beer','wine','gin','vodka','whiskey','whisky','rum','tequila','sake','soju',
  'stout','ale','lager','cocktail','champagne','prosecco','brandy','cognac','bourbon','scotch',
  'cider','mead','grappa','limoncello','amaretto','aperol','spritz','negroni'];

function isTruthy_(v){ return v===true||v==='TRUE'||v==='true'||v==='yes'||v==='YES'||v==='Yes'||v===1||v==='1'; }

function num_(v){ var n=parseFloat(v); return isNaN(n)?null:n; }

function dedupRows_(rows){
  var byDay = {};
  rows.forEach(function(r){
    var d = num_(r.day); if(!d) return;
    var ts = r.timestamp ? new Date(r.timestamp).getTime() : 0;
    if(!byDay[d] || ts > (byDay[d]._ts||0)){
      var copy = {}; for(var k in r) copy[k] = r[k];
      copy.day = d; copy._ts = ts;
      byDay[d] = copy;
    }
  });
  var out = [];
  for(var d in byDay){ var row = byDay[d]; delete row._ts; out.push(row); }
  out.sort(function(a,b){ return a.day - b.day; });
  return out;
}

function findRule_(rules, phase, metric, model){
  phase = (phase||'').toLowerCase().replace('consolidation','stabilization');
  model = model || 'all';
  var r = null;
  for(var i=0;i<rules.length;i++){
    var x=rules[i];
    if(x.phase===phase && x.metric===metric && (x.model===model || x.model==='all')){ r=x; break; }
  }
  if(!r && phase==='transition'){
    for(var j=0;j<rules.length;j++){
      var y=rules[j];
      if(y.phase==='activation' && y.metric===metric && (y.model===model || y.model==='all')){ r=y; break; }
    }
  }
  return r;
}

function bandStatus_(val, rule){
  if(!rule || val==null || !rule.gated) return 'none';
  if(rule.amber_lo!=null && val < rule.amber_lo) return 'red';
  if(rule.amber_hi!=null && val > rule.amber_hi) return 'red';
  if(rule.green_lo!=null && val < rule.green_lo) return 'amber';
  if(rule.green_hi!=null && val > rule.green_hi) return 'amber';
  return 'green';
}

function isAlc_(item){
  var n=String(item.name||'').toLowerCase(), nt=String(item.note||'').toLowerCase(), c=String(item.category||'').toLowerCase();
  if(c==='alcohol') return true;
  for(var i=0;i<ALC_.length;i++){
    var re=new RegExp('\\b'+ALC_[i]+'\\b');
    if(re.test(n)) return true;
  }
  return /\balcohol\b/.test(nt);
}

function deriveCompliance_(data, rules, model){
  return data.map(function(row){
    var issues = [];
    var phase = String(row.phase||'').toLowerCase().replace('consolidation','stabilization');
    var hasData = row.kcal || row.weight || row.notes || row.day_json;
    if(!phase || !hasData) return {day:row.day, date:row.date||'', phase:phase, status:'empty', issues:[]};

    // Weight logged
    var wr = findRule_(rules, phase, 'weight_logged', model);
    if(wr && wr.gated && !row.weight) issues.push({type:'weight',sev:'red',detail:'No weigh-in'});

    // Serum AM/PM
    var sar = findRule_(rules, phase, 'serum_am', model);
    if(sar && sar.gated && !isTruthy_(row.serumam)) issues.push({type:'serum_am',sev:'red',detail:'Missed AM serum'});
    var spr = findRule_(rules, phase, 'serum_pm', model);
    if(spr && spr.gated && !isTruthy_(row.serumpm)) issues.push({type:'serum_pm',sev:'red',detail:'Missed PM serum'});

    // day_json: alcohol + forbidden food
    var dj = null;
    if(row.day_json){
      try{ dj = typeof row.day_json === 'string' ? JSON.parse(row.day_json) : row.day_json; }catch(e){}
    }
    if(dj){
      var meals = Array.isArray(dj) ? dj : (dj.meals || []);
      meals.forEach(function(meal){
        (meal.items||[]).forEach(function(item){
          if(item.verdict === 'no'){
            if(isAlc_(item)){
              var ar = findRule_(rules, phase, 'alcohol', model);
              if(ar && ar.gated) issues.push({type:'alcohol',sev:'red',detail:'Alcohol: '+(item.name||'unknown')});
            } else {
              var fr = findRule_(rules, phase, 'forbidden_food', model);
              if(fr && fr.gated) issues.push({type:'food',sev:'red',detail:'Forbidden: '+(item.name||'unknown')});
            }
          }
        });
      });
    }

    // Alcohol in notes
    if(row.notes && !issues.some(function(i){return i.type==='alcohol';})){
      var nl = String(row.notes).toLowerCase();
      for(var a=0;a<ALC_.length;a++){
        if(new RegExp('\\b'+ALC_[a]+'\\b').test(nl)){
          var ar2 = findRule_(rules, phase, 'alcohol', model);
          if(ar2 && ar2.gated) issues.push({type:'alcohol',sev:'amber',detail:'Alcohol in notes'});
          break;
        }
      }
    }

    // Water
    var wtr = findRule_(rules, phase, 'water_ml', model);
    if(wtr && wtr.gated && row.water_ml!=null){
      var wml = num_(row.water_ml);
      if(wtr.amber_lo!=null && wml<wtr.amber_lo) issues.push({type:'water',sev:'red',detail:'Water: '+wml+'ml'});
      else if(wtr.green_lo!=null && wml<wtr.green_lo) issues.push({type:'water',sev:'amber',detail:'Water low: '+wml+'ml'});
    }

    // Kcal (skip adaptive_kcal basis)
    var kr = findRule_(rules, phase, 'kcal', model);
    if(kr && kr.gated && kr.basis!=='adaptive_kcal' && row.kcal){
      var kst = bandStatus_(num_(row.kcal), kr);
      if(kst==='red') issues.push({type:'kcal',sev:'red',detail:'Kcal: '+row.kcal});
      else if(kst==='amber') issues.push({type:'kcal',sev:'amber',detail:'Kcal: '+row.kcal});
    }

    // Protein (macros model only)
    if(model!=='buckets'){
      var pr = findRule_(rules, phase, 'protein', model);
      if(pr && pr.gated && row.protein){
        var pst = bandStatus_(num_(row.protein), pr);
        if(pst==='red') issues.push({type:'protein',sev:'red',detail:'Protein: '+row.protein+'g'});
        else if(pst==='amber') issues.push({type:'protein',sev:'amber',detail:'Protein: '+row.protein+'g'});
      }
    }

    // Carbs
    var cr = findRule_(rules, phase, 'carbs', model);
    if(cr && cr.gated && row.carbs){
      var cst = bandStatus_(num_(row.carbs), cr);
      if(cst==='red') issues.push({type:'carbs',sev:'red',detail:'Carbs: '+row.carbs+'g'});
      else if(cst==='amber') issues.push({type:'carbs',sev:'amber',detail:'Carbs: '+row.carbs+'g'});
    }

    // Exercise strenuous (info only)
    var er = findRule_(rules, phase, 'exercise_kcal_warn', model);
    if(er && row.exercise_kcal && num_(row.exercise_kcal) > (er.green_hi||Infinity))
      issues.push({type:'exercise',sev:'info',detail:'Strenuous: '+row.exercise_kcal+' kcal'});

    var gated = issues.filter(function(i){return i.sev!=='info';});
    var status = gated.some(function(i){return i.sev==='red';}) ? 'red' : gated.some(function(i){return i.sev==='amber';}) ? 'amber' : 'green';
    return {day:row.day, date:row.date||'', phase:phase, status:status, issues:issues};
  });
}

function computeStats_(data, compliance){
  var ws = data.filter(function(d){return d.weight;}).map(function(d){return {day:d.day, w:num_(d.weight)};});
  var sw = ws.length ? ws[0].w : null;
  var ew = ws.length ? ws[ws.length-1].w : null;
  var pk = ws.length ? Math.max.apply(null, ws.map(function(w){return w.w;})) : null;
  var delta = (sw!=null && ew!=null) ? ew - sw : null;
  var scored = compliance.filter(function(c){return c.status!=='empty';});
  var total = scored.length;
  var redFreeDays = scored.filter(function(c){return !c.issues.some(function(i){return i.sev==='red';});}).length;
  var pct = total ? Math.round(redFreeDays / total * 100) : 0;
  var exDays = data.filter(function(d){return num_(d.exercise_kcal)>0;}).length;
  var kcalRows = data.filter(function(d){return d.kcal;});
  var avgKcal = kcalRows.length ? Math.round(kcalRows.reduce(function(s,d){return s+num_(d.kcal);},0) / kcalRows.length) : 0;
  return {
    startWeight:sw, endWeight:ew, peakWeight:pk, delta:delta,
    totalDays:data.length, scoredDays:total, redFreeDays:redFreeDays,
    compliancePct:pct, exerciseDays:exDays, avgKcal:avgKcal
  };
}

function json(obj){
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
