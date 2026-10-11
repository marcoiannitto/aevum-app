/**
 * AEVUM API v2.0.0
 *
 * Replaces both the GAS backend and the proxy Worker.
 * Uses Cloudflare D1 (SQLite) instead of Google Sheets.
 * Adds token-based auth with per-user data isolation.
 *
 * Routes: register, profile, sync, getdays, rules, config,
 *   messages, recipes, fitness, foods, policy, mealplan,
 *   settarget, savetarget, graduation, estimate, foodcheck,
 *   shoplist, mealengine
 *
 * Admin routes (require admin token):
 *   admin_users, admin_export, admin_seed
 */

// ─── Constants ───────────────────────────────────────────────
const PH_FIXED = { loading: 2, transition: 3, stabilization: 18 };
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const AI_WORKER_DEFAULT = 'https://sweet-fire-a436.marco-iannitto.workers.dev/';

const ALC_WORDS = [
  'alcohol','beer','wine','gin','vodka','whiskey','whisky','rum','tequila','sake','soju',
  'stout','ale','lager','cocktail','champagne','prosecco','brandy','cognac','bourbon','scotch',
  'cider','mead','grappa','limoncello','amaretto','aperol','spritz','negroni'
];

// Rate limiter (per-isolate, best effort)
const rateMap = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW = 60000;

function rateCheck(ip) {
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    entry = { start: now, count: 0 };
    rateMap.set(ip, entry);
  }
  entry.count++;
  if (rateMap.size > 10000) {
    for (const [k, v] of rateMap) {
      if (now - v.start > RATE_WINDOW) rateMap.delete(k);
    }
  }
  return entry.count <= RATE_LIMIT;
}

// ─── CORS ────────────────────────────────────────────────────
function corsHeaders(origin, allowed) {
  const ok = origin === allowed
    || origin === 'http://localhost:8080'
    || origin === 'http://127.0.0.1:8080';
  if (!ok) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

function json(data, cors, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

// ─── Auth middleware ─────────────────────────────────────────
async function authenticate(request, db) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;
  const row = await db.prepare(
    'SELECT user_id, role FROM auth_tokens WHERE token = ? AND (expires_at IS NULL OR expires_at > datetime("now"))'
  ).bind(token).first();
  return row || null;
}

// ─── Helpers ─────────────────────────────────────────────────
function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
function isTruthy(v) {
  return v === true || v === 1 || v === '1' || v === 'yes' || v === 'YES' || v === 'Yes'
    || v === 'true' || v === 'TRUE';
}
function actDays(profile) {
  const a = parseFloat((profile || {}).activation_days);
  return a > 0 ? a : 8;
}
function resetDay(profile) {
  return PH_FIXED.loading + actDays(profile) + PH_FIXED.transition;
}

// ─── Main handler ────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || 'https://beta.niramaya.sg';
    const cors = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') {
      if (!cors) return new Response('Forbidden', { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    if (!cors) return new Response('Forbidden', { status: 403 });

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!rateCheck(ip)) return json({ error: 'Too many requests' }, cors, 429);

    let body;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return json({ error: 'Invalid JSON' }, cors, 400);
    }

    const action = body && body.action;
    if (!action) return json({ error: 'Missing action' }, cors, 400);

    const db = env.DB;

    try {
      // Unauthenticated routes
      if (action === 'register') return json(await doRegister(body, db), cors);
      if (action === 'auth_google') return json(await authGoogle(body, db, env), cors);
      if (action === 'login') return json(await doLogin(body, db), cors);

      // Auth check
      const auth = await authenticate(request, db);
      if (!auth) return json({ error: 'Unauthorized' }, cors, 401);

      const userId = auth.user_id;
      const isAdmin = auth.role === 'admin';

      // Admin routes
      if (action === 'admin_users' && isAdmin) return json(await adminUsers(db), cors);
      if (action === 'admin_export' && isAdmin) return json(await adminExport(body, db), cors);
      if (action === 'admin_seed' && isAdmin)   return json(await adminSeed(body, db), cors);

      // User routes
      switch (action) {
        case 'profile':    return json(await getProfile(userId, db), cors);
        case 'complete_profile': return json(await completeProfile(userId, body, db), cors);
        case 'sync':       return json(await syncRow(userId, body, db), cors);
        case 'getdays':    return json(await getDays(userId, db), cors);
        case 'rules':      return json(await getRules(userId, db), cors);
        case 'config':     return json(await getConfig(db), cors);
        case 'messages':   return json(await getMessages(db), cors);
        case 'recipes':    return json(await getRecipes(db), cors);
        case 'fitness':    return json(await getFitness(db), cors);
        case 'foods':      return json(await getFoods(body, db), cors);
        case 'policy':     return json(await getPolicy(body, db), cors);
        case 'mealplan':   return json(await getMealPlan(userId, db), cors);
        case 'settarget':  return json(await setStabTarget(userId, body, db), cors);
        case 'savetarget': return json(await saveTargetRow(userId, body, db), cors);
        case 'graduation': return json(await graduation(userId, body, db, isAdmin), cors);
        case 'mealengine': return json(await mealEngine(userId, body, db), cors);
        case 'estimate':   return json(await estimateMeal(userId, body, db, env), cors);
        case 'foodcheck':  return json(await foodCheck(body, db, env), cors);
        case 'shoplist':   return json(await shopList(body, env), cors);
        default: return json({ error: 'Unknown action' }, cors, 400);
      }
    } catch (err) {
      return json({ error: String(err.message || err) }, cors, 500);
    }
  }
};

// ═══════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ═══════════════════════════════════════════════════════════════

// ─── Register ────────────────────────────────────────────────
async function doRegister(body, db) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'name required' };
  const sex = String(body.sex || '').toLowerCase();
  if (sex !== 'm' && sex !== 'f') return { error: 'sex must be m or f' };
  const age = parseInt(body.age) || 0;
  const height = parseFloat(body.height) || 0;
  const weight = parseFloat(body.weight) || 0;
  const act = parseFloat(body.act) || 1.55;
  const target_kg = parseFloat(body.target_kg) || null;
  if (!age || !height || !weight) return { error: 'age, height, weight required' };

  // Mifflin TDEE
  const s = sex === 'm' ? 5 : -161;
  const tdee = Math.round((10 * weight + 6.25 * height - 5 * age + s) * act);

  // Generate unique ID
  const base = name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 8);
  const rnd = Math.random().toString(36).slice(2, 6);
  const id = base + '_' + rnd;

  // Generate auth token
  const token = crypto.randomUUID();

  await db.batch([
    db.prepare(
      `INSERT INTO users (id, name, sex, age, height, start_weight, activity, target_kg,
        current_target_kcal, program) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(id, name, sex, age, height, weight, act, target_kg, tdee),
    db.prepare(
      'INSERT INTO auth_tokens (token, user_id, role) VALUES (?, ?, ?)'
    ).bind(token, id, 'user')
  ]);

  return { id, token, program: false, current_target_kcal: tdee };
}

// ─── Google Auth ────────────────────────────────────────────
// Verifies a Google ID token (from Google Identity Services on the frontend),
// looks up user by email or creates a new one, returns an app token.
async function authGoogle(body, db, env) {
  const idToken = String(body.id_token || '').trim();
  if (!idToken) return { error: 'id_token required' };

  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) return { error: 'Google login not configured' };

  // Verify the token via Google's tokeninfo endpoint
  const resp = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!resp.ok) return { error: 'Invalid Google token' };
  const goog = await resp.json();

  // Verify audience matches our client ID
  if (goog.aud !== clientId) return { error: 'Token audience mismatch' };

  const email = (goog.email || '').toLowerCase().trim();
  const name = goog.name || goog.given_name || email.split('@')[0];
  if (!email) return { error: 'No email in Google token' };

  // Check if user exists with this email
  let user = await db.prepare('SELECT id, program FROM users WHERE email = ?').bind(email).first();

  if (user) {
    // Existing user: issue or reuse token
    let tokenRow = await db.prepare('SELECT token FROM auth_tokens WHERE user_id = ? AND role = ?')
      .bind(user.id, 'user').first();
    if (!tokenRow) {
      const token = crypto.randomUUID();
      await db.prepare('INSERT INTO auth_tokens (token, user_id, role) VALUES (?, ?, ?)')
        .bind(token, user.id, 'user').run();
      tokenRow = { token };
    }
    return { id: user.id, token: tokenRow.token, program: !!user.program, existing: true };
  }

  // New user: create with Google profile info
  const base = name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 8) || 'user';
  const rnd = Math.random().toString(36).slice(2, 6);
  const id = base + '_' + rnd;
  const token = crypto.randomUUID();

  await db.batch([
    db.prepare(
      `INSERT INTO users (id, name, email, program) VALUES (?, ?, ?, 0)`
    ).bind(id, name, email),
    db.prepare(
      'INSERT INTO auth_tokens (token, user_id, role) VALUES (?, ?, ?)'
    ).bind(token, id, 'user')
  ]);

  return { id, token, program: false, existing: false, needs_profile: true };
}

// ─── Token Login (returning users) ──────────────────────────
async function doLogin(body, db) {
  const token = String(body.token || '').trim();
  if (!token) return { error: 'token required' };

  const row = await db.prepare(
    'SELECT user_id, role FROM auth_tokens WHERE token = ? AND (expires_at IS NULL OR expires_at > datetime("now"))'
  ).bind(token).first();

  if (!row) return { error: 'Invalid or expired token' };

  const user = await db.prepare('SELECT id, name, program FROM users WHERE id = ?')
    .bind(row.user_id).first();

  if (!user) return { error: 'User not found' };

  return { id: user.id, name: user.name, program: !!user.program, valid: true };
}

// ─── Complete Profile (for Google-authed users who need profile data) ─────
async function completeProfile(userId, body, db) {
  const sex = String(body.sex || '').toLowerCase();
  if (sex !== 'm' && sex !== 'f') return { error: 'sex must be m or f' };
  const age = parseInt(body.age) || 0;
  const height = parseFloat(body.height) || 0;
  const weight = parseFloat(body.weight) || 0;
  const act = parseFloat(body.act) || 1.55;
  const target_kg = parseFloat(body.target_kg) || null;
  if (!age || !height || !weight) return { error: 'age, height, weight required' };

  const s = sex === 'm' ? 5 : -161;
  const tdee = Math.round((10 * weight + 6.25 * height - 5 * age + s) * act);

  await db.prepare(
    `UPDATE users SET sex=?, age=?, height=?, start_weight=?, activity=?,
     target_kg=?, current_target_kcal=? WHERE id=?`
  ).bind(sex, age, height, weight, act, target_kg, tdee, userId).run();

  return { ok: true, current_target_kcal: tdee };
}

// ─── Profile ─────────────────────────────────────────────────
async function getProfile(userId, db) {
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!row) return { profile: null };
  return {
    profile: {
      id: row.id,
      name: row.name,
      target_kg: row.target_kg,
      start_weight: row.start_weight,
      start_date: row.start_date || '',
      height: row.height,
      activation_days: row.activation_days,
      stab_target_weight: row.stab_target_weight,
      current_target_kcal: row.current_target_kcal,
      prev_target_kcal: row.prev_target_kcal,
      last_review_date: row.last_review_date || '',
      last_change_reason: row.last_change_reason || '',
      maintenance_mode: row.maintenance_mode || '',
      maintenance_diet: row.maintenance_diet || '',
      program: !!row.program,
      notes: row.notes || ''
    }
  };
}

// ─── Sync (upsert daily log) ─────────────────────────────────
async function syncRow(userId, body, db) {
  await db.prepare(
    `INSERT INTO daily_logs (user_id, day, phase, date, weight, waist,
      serum_am, serum_pm, kcal, protein, fat, carbs, water_ml,
      exercise, exercise_kcal, energy, hunger, sleep, notes, day_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, day) DO UPDATE SET
      phase=excluded.phase, date=excluded.date, weight=excluded.weight,
      waist=excluded.waist, serum_am=excluded.serum_am, serum_pm=excluded.serum_pm,
      kcal=excluded.kcal, protein=excluded.protein, fat=excluded.fat,
      carbs=excluded.carbs, water_ml=excluded.water_ml,
      exercise=excluded.exercise, exercise_kcal=excluded.exercise_kcal,
      energy=excluded.energy, hunger=excluded.hunger, sleep=excluded.sleep,
      notes=excluded.notes, day_json=excluded.day_json,
      updated_at=datetime('now')`
  ).bind(
    userId, body.day || 0, body.phase || '', body.date || '',
    body.weight || null, body.waist || null,
    body.serumAM ? 'yes' : '', body.serumPM ? 'yes' : '',
    body.kcal || 0, body.protein || 0, body.fat || 0, body.carbs || 0,
    body.water_ml || 0, body.exercise || '', body.exercise_kcal || 0,
    body.energy || '', body.hunger || '', body.sleep || '',
    body.notes || '', body.day_json || ''
  ).run();

  return { ok: true };
}

// ─── Get days (restore) ──────────────────────────────────────
async function getDays(userId, db) {
  const rows = await db.prepare(
    'SELECT day, day_json FROM daily_logs WHERE user_id = ? ORDER BY day'
  ).bind(userId).all();
  return { days: rows.results.map(r => ({ day: r.day, day_json: r.day_json || '' })) };
}

// ─── Meal plan ───────────────────────────────────────────────
async function getMealPlan(userId, db) {
  const rows = await db.prepare(
    'SELECT day, meal, recipe, kcal, protein, fat, carbs FROM meal_plans WHERE user_id = ? ORDER BY day'
  ).bind(userId).all();
  return { plan: rows.results };
}

// ─── Config ──────────────────────────────────────────────────
async function getConfig(db) {
  const rows = await db.prepare('SELECT key, value FROM config').all();
  return { config: rows.results };
}

// ─── Messages ────────────────────────────────────────────────
async function getMessages(db) {
  const rows = await db.prepare(
    'SELECT id, trigger, enabled, phase, priority, title, body, badge, frequency FROM messages ORDER BY priority DESC'
  ).all();
  return { messages: rows.results };
}

// ─── Recipes ─────────────────────────────────────────────────
async function getRecipes(db) {
  const rows = await db.prepare('SELECT * FROM recipes').all();
  return {
    recipes: rows.results.map(r => ({
      name: r.name,
      protein: r.protein,
      cuisine: r.cuisine,
      phase: r.phase || '',
      kcal: r.kcal || 0,
      protein_g: r.protein_g || 0,
      fat_g: r.fat_g || 0,
      carbs_g: r.carbs_g || 0,
      ingredients: (r.ingredients || '').split('||').map(s => s.trim()).filter(Boolean),
      steps: (r.steps || '').split('||').map(s => s.trim()).filter(Boolean)
    }))
  };
}

// ─── Fitness ─────────────────────────────────────────────────
async function getFitness(db) {
  const mv = await db.prepare('SELECT * FROM movements').all();
  const wk = await db.prepare('SELECT * FROM workouts ORDER BY workout_id, sort_order').all();
  return { movements: mv.results, workouts: wk.results };
}

// ─── Foods ───────────────────────────────────────────────────
async function getFoods(body, db) {
  const want = String(body.phase || '').trim().toLowerCase();
  let rows;
  if (want) {
    rows = await db.prepare('SELECT * FROM foods WHERE phase = ?').bind(want).all();
    // transition inherits activation
    if (want === 'transition' && rows.results.length === 0) {
      rows = await db.prepare('SELECT * FROM foods WHERE phase = ?').bind('activation').all();
      rows.results = rows.results.map(r => ({ ...r, phase: 'transition' }));
    }
  } else {
    rows = await db.prepare('SELECT * FROM foods').all();
    // add transition inheriting activation if none exist
    const hasTransition = rows.results.some(r => r.phase === 'transition');
    if (!hasTransition) {
      const actRows = rows.results.filter(r => r.phase === 'activation');
      rows.results.push(...actRows.map(r => ({ ...r, phase: 'transition' })));
    }
  }
  return { foods: rows.results.map(r => ({
    phase: r.phase, category: r.category, subcategory: r.subcategory,
    item: r.item, verdict: r.verdict, cap_g: r.cap_g, note: r.note
  }))};
}

// ─── Policy ──────────────────────────────────────────────────
async function getPolicy(body, db) {
  const want = String(body.phase || '').trim().toLowerCase();
  let rows;
  if (want) {
    rows = await db.prepare('SELECT phase, rules_text FROM policy WHERE phase = ?').bind(want).all();
    if (rows.results.length === 0 && want === 'transition') {
      rows = await db.prepare('SELECT phase, rules_text FROM policy WHERE phase = ?').bind('activation').all();
      rows.results = rows.results.map(r => ({ ...r, phase: 'transition' }));
    }
    if (rows.results.length === 0 && want === 'maintenance') {
      rows = await db.prepare('SELECT phase, rules_text FROM policy WHERE phase = ?').bind('stabilization').all();
      rows.results = rows.results.map(r => ({ ...r, phase: 'maintenance' }));
    }
  } else {
    rows = await db.prepare('SELECT phase, rules_text FROM policy').all();
    if (!rows.results.some(r => r.phase === 'transition')) {
      const act = rows.results.find(r => r.phase === 'activation');
      if (act) rows.results.push({ phase: 'transition', rules_text: act.rules_text });
    }
  }
  return { policy: rows.results };
}

async function getPolicyText(phase, db) {
  const want = String(phase || '').trim().toLowerCase();
  if (!want) return '';
  const row = await db.prepare('SELECT rules_text FROM policy WHERE phase = ?').bind(want).first();
  if (row) return row.rules_text;
  const fallback = want === 'transition' ? 'activation' : (want === 'maintenance' ? 'stabilization' : null);
  if (fallback) {
    const fb = await db.prepare('SELECT rules_text FROM policy WHERE phase = ?').bind(fallback).first();
    if (fb) return fb.rules_text;
  }
  return '';
}

// ─── Rules ───────────────────────────────────────────────────
async function getRules(userId, db) {
  // Get user's model + target weight
  let model = 'buckets', targetWeight = null;
  const user = await db.prepare('SELECT activation_model, stab_target_weight, target_kg, start_weight FROM users WHERE id = ?').bind(userId).first();
  if (user) {
    const m = String(user.activation_model || '').toLowerCase();
    if (m === 'macros' || m === 'buckets') model = m;
    targetWeight = user.stab_target_weight || user.target_kg || user.start_weight || null;
  }

  const rows = await db.prepare('SELECT * FROM rules').all();
  const maintDiets = ['keto', 'high_protein', 'balanced'];
  const out = [];

  for (const r of rows.results) {
    const rowModel = String(r.model || 'all').toLowerCase();
    if (rowModel !== 'all' && rowModel !== model && !maintDiets.includes(rowModel)) continue;

    let target = r.value, bands = { green_lo: r.green_lo, green_hi: r.green_hi, amber_lo: r.amber_lo, amber_hi: r.amber_hi };
    const basis = String(r.basis || 'fixed').toLowerCase();

    if (basis === 'per_kg_target_weight' && targetWeight) {
      const mult = x => x == null ? null : Math.round(x * targetWeight);
      target = mult(r.value);
      bands = { green_lo: mult(r.green_lo), green_hi: mult(r.green_hi), amber_lo: mult(r.amber_lo), amber_hi: mult(r.amber_hi) };
    } else if (basis === 'adaptive_kcal') {
      target = null;
    }

    out.push({
      phase: r.phase, model: rowModel, metric: r.metric, basis,
      target, green_lo: bands.green_lo, green_hi: bands.green_hi,
      amber_lo: bands.amber_lo, amber_hi: bands.amber_hi,
      gated: String(r.gated || '').toLowerCase() !== 'no',
      unit: r.unit || ''
    });
  }

  // transition inherits activation
  if (!out.some(x => x.phase === 'transition')) {
    out.filter(x => x.phase === 'activation').forEach(x => out.push({ ...x, phase: 'transition' }));
  }
  // maintenance inherits stabilization
  if (!out.some(x => x.phase === 'maintenance')) {
    out.filter(x => x.phase === 'stabilization').forEach(x => out.push({ ...x, phase: 'maintenance' }));
  }

  return { model, target_weight: targetWeight, rules: out };
}

// ─── Set stabilization target ────────────────────────────────
async function setStabTarget(userId, body, db) {
  const val = parseFloat(body.stab_target_weight);
  if (!(val > 0)) return { error: 'bad input' };
  const user = await db.prepare('SELECT stab_target_weight FROM users WHERE id = ?').bind(userId).first();
  if (!user) return { error: 'id not found' };
  if (!(parseFloat(user.stab_target_weight) > 0)) {
    await db.prepare('UPDATE users SET stab_target_weight = ? WHERE id = ?').bind(val, userId).run();
  }
  return { ok: true };
}

// ─── Save adaptive target fields ─────────────────────────────
async function saveTargetRow(userId, body, db) {
  const fields = [];
  const vals = [];
  const map = {
    current_target_kcal: body.current_target_kcal,
    prev_target_kcal: body.prev_target_kcal,
    last_review_date: body.last_review_date,
    last_change_reason: body.last_change_reason
  };
  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined) { fields.push(`${k} = ?`); vals.push(v); }
  }
  if (!fields.length) return { error: 'nothing to update' };
  vals.push(userId);
  await db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run();
  return { ok: true };
}

// ─── Graduation (dashboard endpoint) ─────────────────────────
async function graduation(userId, body, db, isAdmin) {
  const sub = String(body.sub || '').trim();

  // sub=clients: list all profiles (admin only)
  if (sub === 'clients') {
    if (!isAdmin) return { error: 'admin only' };
    const rows = await db.prepare('SELECT id, name FROM users').all();
    return { clients: rows.results };
  }

  // sub=full or sub=reset
  if (sub === 'full' || sub === 'reset') {
    const targetId = isAdmin && body.id ? String(body.id).toLowerCase() : userId;
    const prof = await getProfile(targetId, db);
    const rulesResp = await getRules(targetId, db);

    const logRows = await db.prepare(
      'SELECT * FROM daily_logs WHERE user_id = ? ORDER BY day'
    ).bind(targetId).all();

    let data = logRows.results.map(r => ({
      day: r.day, phase: r.phase, date: r.date,
      weight: r.weight, waist: r.waist,
      serumam: r.serum_am, serumpm: r.serum_pm,
      kcal: r.kcal, protein: r.protein, fat: r.fat, carbs: r.carbs,
      water_ml: r.water_ml, exercise: r.exercise,
      exercise_kcal: r.exercise_kcal, energy: r.energy,
      hunger: r.hunger, sleep: r.sleep, notes: r.notes,
      day_json: r.day_json
    }));

    if (sub === 'reset') {
      const rd = resetDay(prof.profile || {});
      data = data.filter(r => (r.day || 0) <= rd);
    }

    const model = rulesResp.model || 'buckets';
    const rules = rulesResp.rules || [];
    const compliance = deriveCompliance(data, rules, model);
    const stats = computeStats(data, compliance);

    return { profile: prof.profile, model, data, rules, compliance, stats };
  }

  // Save maintenance mode / diet
  const mode = String(body.mode || '').trim().toLowerCase();
  const diet = String(body.diet || '').trim().toLowerCase();
  if ((mode || diet) && !sub) {
    if (mode && mode !== 'maintain' && mode !== 'cut') return { error: 'invalid mode' };
    if (diet && diet !== 'keto' && diet !== 'high_protein' && diet !== 'balanced') return { error: 'invalid diet' };
    const sets = [];
    const vals = [];
    if (mode) { sets.push('maintenance_mode = ?'); vals.push(mode); }
    if (diet) { sets.push('maintenance_diet = ?'); vals.push(diet); }
    vals.push(userId);
    await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    return { ok: true, mode: mode || '', diet: diet || '' };
  }

  return { error: 'unknown graduation sub: ' + sub };
}

// ─── Compliance engine (ported from GAS) ─────────────────────
function findRule(rules, phase, metric, model) {
  phase = (phase || '').toLowerCase().replace('consolidation', 'stabilization');
  let r = rules.find(x => x.phase === phase && x.metric === metric && (x.model === model || x.model === 'all'));
  if (!r && phase === 'transition') {
    r = rules.find(x => x.phase === 'activation' && x.metric === metric && (x.model === model || x.model === 'all'));
  }
  return r || null;
}

function bandStatus(val, rule) {
  if (!rule || val == null || !rule.gated) return 'none';
  if (rule.amber_lo != null && val < rule.amber_lo) return 'red';
  if (rule.amber_hi != null && val > rule.amber_hi) return 'red';
  if (rule.green_lo != null && val < rule.green_lo) return 'amber';
  if (rule.green_hi != null && val > rule.green_hi) return 'amber';
  return 'green';
}

function isAlc(item) {
  const n = String(item.name || '').toLowerCase();
  const nt = String(item.note || '').toLowerCase();
  const c = String(item.category || '').toLowerCase();
  if (c === 'alcohol') return true;
  for (const word of ALC_WORDS) {
    if (new RegExp('\\b' + word + '\\b').test(n)) return true;
  }
  return /\balcohol\b/.test(nt);
}

function deriveCompliance(data, rules, model) {
  return data.map(row => {
    const issues = [];
    const phase = String(row.phase || '').toLowerCase().replace('consolidation', 'stabilization');
    const hasData = row.kcal || row.weight || row.notes || row.day_json;
    if (!phase || !hasData) return { day: row.day, date: row.date || '', phase, status: 'empty', issues: [] };

    // Weight logged
    const wr = findRule(rules, phase, 'weight_logged', model);
    if (wr && wr.gated && !row.weight) issues.push({ type: 'weight', sev: 'red', detail: 'No weigh-in' });

    // Serum AM/PM
    const sar = findRule(rules, phase, 'serum_am', model);
    if (sar && sar.gated && !isTruthy(row.serumam)) issues.push({ type: 'serum_am', sev: 'red', detail: 'Missed AM serum' });
    const spr = findRule(rules, phase, 'serum_pm', model);
    if (spr && spr.gated && !isTruthy(row.serumpm)) issues.push({ type: 'serum_pm', sev: 'red', detail: 'Missed PM serum' });

    // day_json: alcohol + forbidden food
    let dj = null;
    if (row.day_json) {
      try { dj = typeof row.day_json === 'string' ? JSON.parse(row.day_json) : row.day_json; } catch {}
    }
    if (dj) {
      const meals = Array.isArray(dj) ? dj : (dj.meals || []);
      for (const meal of meals) {
        for (const item of (meal.items || [])) {
          if (item.verdict === 'no') {
            if (isAlc(item)) {
              const ar = findRule(rules, phase, 'alcohol', model);
              if (ar && ar.gated) issues.push({ type: 'alcohol', sev: 'red', detail: 'Alcohol: ' + (item.name || 'unknown') });
            } else {
              const fr = findRule(rules, phase, 'forbidden_food', model);
              if (fr && fr.gated) issues.push({ type: 'food', sev: 'red', detail: 'Forbidden: ' + (item.name || 'unknown') });
            }
          }
        }
      }
    }

    // Alcohol in notes
    if (row.notes && !issues.some(i => i.type === 'alcohol')) {
      const nl = String(row.notes).toLowerCase();
      for (const word of ALC_WORDS) {
        if (new RegExp('\\b' + word + '\\b').test(nl)) {
          const ar2 = findRule(rules, phase, 'alcohol', model);
          if (ar2 && ar2.gated) issues.push({ type: 'alcohol', sev: 'amber', detail: 'Alcohol in notes' });
          break;
        }
      }
    }

    // Water
    const wtr = findRule(rules, phase, 'water_ml', model);
    if (wtr && wtr.gated && row.water_ml != null) {
      const wml = num(row.water_ml);
      if (wtr.amber_lo != null && wml < wtr.amber_lo) issues.push({ type: 'water', sev: 'red', detail: 'Water: ' + wml + 'ml' });
      else if (wtr.green_lo != null && wml < wtr.green_lo) issues.push({ type: 'water', sev: 'amber', detail: 'Water low: ' + wml + 'ml' });
    }

    // Kcal
    const kr = findRule(rules, phase, 'kcal', model);
    if (kr && kr.gated && kr.basis !== 'adaptive_kcal' && row.kcal) {
      const kst = bandStatus(num(row.kcal), kr);
      if (kst === 'red') issues.push({ type: 'kcal', sev: 'red', detail: 'Kcal: ' + row.kcal });
      else if (kst === 'amber') issues.push({ type: 'kcal', sev: 'amber', detail: 'Kcal: ' + row.kcal });
    }

    // Protein (macros model only)
    if (model !== 'buckets') {
      const pr = findRule(rules, phase, 'protein', model);
      if (pr && pr.gated && row.protein) {
        const pst = bandStatus(num(row.protein), pr);
        if (pst === 'red') issues.push({ type: 'protein', sev: 'red', detail: 'Protein: ' + row.protein + 'g' });
        else if (pst === 'amber') issues.push({ type: 'protein', sev: 'amber', detail: 'Protein: ' + row.protein + 'g' });
      }
    }

    // Carbs
    const cr = findRule(rules, phase, 'carbs', model);
    if (cr && cr.gated && row.carbs) {
      const cst = bandStatus(num(row.carbs), cr);
      if (cst === 'red') issues.push({ type: 'carbs', sev: 'red', detail: 'Carbs: ' + row.carbs + 'g' });
      else if (cst === 'amber') issues.push({ type: 'carbs', sev: 'amber', detail: 'Carbs: ' + row.carbs + 'g' });
    }

    // Exercise strenuous
    const er = findRule(rules, phase, 'exercise_kcal_warn', model);
    if (er && row.exercise_kcal && num(row.exercise_kcal) > (er.green_hi || Infinity))
      issues.push({ type: 'exercise', sev: 'info', detail: 'Strenuous: ' + row.exercise_kcal + ' kcal' });

    const gated = issues.filter(i => i.sev !== 'info');
    const status = gated.some(i => i.sev === 'red') ? 'red' : gated.some(i => i.sev === 'amber') ? 'amber' : 'green';
    return { day: row.day, date: row.date || '', phase, status, issues };
  });
}

function computeStats(data, compliance) {
  const ws = data.filter(d => d.weight).map(d => ({ day: d.day, w: num(d.weight) }));
  const sw = ws.length ? ws[0].w : null;
  const ew = ws.length ? ws[ws.length - 1].w : null;
  const pk = ws.length ? Math.max(...ws.map(w => w.w)) : null;
  const delta = sw != null && ew != null ? ew - sw : null;
  const scored = compliance.filter(c => c.status !== 'empty');
  const total = scored.length;
  const redFreeDays = scored.filter(c => !c.issues.some(i => i.sev === 'red')).length;
  const pct = total ? Math.round(redFreeDays / total * 100) : 0;
  const exDays = data.filter(d => num(d.exercise_kcal) > 0).length;
  const kcalRows = data.filter(d => d.kcal);
  const avgKcal = kcalRows.length ? Math.round(kcalRows.reduce((s, d) => s + num(d.kcal), 0) / kcalRows.length) : 0;
  return {
    startWeight: sw, endWeight: ew, peakWeight: pk, delta,
    totalDays: data.length, scoredDays: total, redFreeDays,
    compliancePct: pct, exerciseDays: exDays, avgKcal
  };
}

// ─── Meal engine ─────────────────────────────────────────────
const ME = {
  IBW_MEN: h => 50 + 0.9 * (h - 152),
  IBW_WOMEN: h => 45.5 + 0.9 * (h - 152),
  P_PER_KG: 1.5, C_DAILY: 50, C_LOW_BW: 30, C_BW_THRESHOLD: 60, F_DAILY: 0,
  SUPPLEMENT: { name: 'AEVUM_ITALY', protein_g: 28, kcal: 112, fat_g: 0, carbs_g: 0 },
  EATING_WINDOW_H: 8, FASTING_H: 16,
  SLOTS: ['Meal 1', 'Meal 2', 'Snack 1', 'Snack 2', 'Fruit'],
  MAIN_MEAL_SLOTS: ['Meal 1', 'Meal 2'],
  SNACK_SLOTS: ['Snack 1', 'Snack 2'],
  FRUIT_SLOTS: ['Fruit'],
  VEG_MIN_G: 100, VEG_MAX_G: 200, FRUIT_CAP_G: 100,
  PROTEINS: {
    allowed: ['chicken breast','turkey breast','cod','sea bass','sea bream','sole','hake','prawns','shrimp','squid','octopus','cuttlefish','clams','mussels','egg whites','tofu','veal (lean)','rabbit','horse meat','bresaola'],
    limited: ['turkey thigh','swordfish','tuna (fresh)','tempeh','fesa di tacchino','prosciutto crudo (no fat)','prosciutto cotto (no fat)'],
    not_allowed: ['salmon','mackerel','sardines','pork','bacon','sausage','ham','whole eggs','cheese','any cured/processed meat with fat']
  },
  VEGETABLES: {
    allowed: ['zucchini','spinach','lettuce','rocket/arugula','kale','chard','broccoli','cauliflower','asparagus','green beans','cucumber','celery','fennel','mushrooms','bell peppers','tomatoes','radish','eggplant','artichoke','chicory','radicchio','cabbage','brussels sprouts','endive'],
    limited: ['onion','carrot','beetroot','pumpkin'],
    not_allowed: ['potato','sweet potato','corn','peas','beans','lentils','chickpeas','any dried/dehydrated vegetable']
  },
  FRUIT: {
    allowed: ['apple','orange','grapefruit','strawberries','blueberries','raspberries','blackberries','lemon','lime','peach','plum'],
    not_allowed: ['banana','grape','mango','pineapple','cherry','lychee','persimmon','watermelon','melon','dried fruit','fruit juice']
  },
  COOKING_METHODS: {
    allowed: ['grilled','boiled','steamed','baked','poached','raw','air-fried (no oil)','microwave'],
    not_allowed: ['fried','deep-fried','sauteed in oil','breaded','battered','pan-fried with fat']
  },
  SEASONINGS: {
    allowed: ['salt','pepper','herbs (fresh/dried)','spices','lemon juice','lime juice','vinegar','garlic','chilli','mustard (no sugar)','soy sauce (small amount)'],
    not_allowed: ['oil','butter','mayo','cream','sugar','honey','ketchup','BBQ sauce','any sauce with fat or sugar']
  },
  SNACK_ITEMS: {
    allowed: ['fat-free greek yogurt','dark chocolate (>85%)','bresaola','prosciutto crudo (no fat)','prosciutto cotto (no fat)','fesa di tacchino'],
    rules: 'Cured meat snacks limited to 1-2 times per week for health.'
  },
  PLAN_DAYS: 5, ACTIVATION_DEFAULT_DAYS: 8
};

async function mealEngine(userId, body, db) {
  const sub = String(body.sub || '');

  if (sub === 'calc') {
    const sex = String(body.sex || 'm').toLowerCase();
    const height = parseFloat(body.height);
    const weight = parseFloat(body.weight);
    if (!height || !weight) return { error: 'height and weight required' };

    const ibw = sex === 'f' ? ME.IBW_WOMEN(height) : ME.IBW_MEN(height);
    const p_daily = ME.P_PER_KG * ibw;
    const p_food = p_daily - ME.SUPPLEMENT.protein_g;
    const c_daily = weight < ME.C_BW_THRESHOLD ? ME.C_LOW_BW : ME.C_DAILY;
    const kcal_food = 4 * p_food + 4 * c_daily;
    const kcal_total = kcal_food + ME.SUPPLEMENT.kcal;
    const p_per_meal = Math.round(p_food / ME.MAIN_MEAL_SLOTS.length);
    const c_per_meal = Math.round(c_daily / ME.MAIN_MEAL_SLOTS.length);

    return {
      ibw: Math.round(ibw * 10) / 10,
      p_daily: Math.round(p_daily), p_food: Math.round(p_food),
      c_daily, f_daily: 0,
      kcal_estimate: Math.round(kcal_total),
      supplement: ME.SUPPLEMENT,
      per_meal: { protein_g: p_per_meal, carbs_g: c_per_meal, fat_g: 0 },
      activation_days: parseInt(body.activation_days) || ME.ACTIVATION_DEFAULT_DAYS,
      slots: ME.SLOTS
    };
  }

  if (sub === 'config') {
    return {
      proteins: ME.PROTEINS, vegetables: ME.VEGETABLES, fruit: ME.FRUIT,
      cooking_methods: ME.COOKING_METHODS, seasonings: ME.SEASONINGS,
      snack_items: ME.SNACK_ITEMS, supplement: ME.SUPPLEMENT,
      slots: ME.SLOTS, fruit_cap_g: ME.FRUIT_CAP_G,
      veg_range: [ME.VEG_MIN_G, ME.VEG_MAX_G], plan_days: ME.PLAN_DAYS
    };
  }

  if (sub === 'validate') {
    const flags = [];
    for (const item of (body.items || [])) {
      const name = String(item.name || '').toLowerCase();
      const type = String(item.type || '');
      if (type === 'protein' && ME.PROTEINS.not_allowed.some(p => name.includes(p.toLowerCase())))
        flags.push({ item: item.name, issue: 'not allowed in Activation' });
      if (type === 'vegetable' && ME.VEGETABLES.not_allowed.some(v => name.includes(v.toLowerCase())))
        flags.push({ item: item.name, issue: 'starchy/not allowed' });
      if (type === 'fruit') {
        if (ME.FRUIT.not_allowed.some(f => name.includes(f.toLowerCase())))
          flags.push({ item: item.name, issue: 'too much sugar' });
        if ((+item.grams || 0) > ME.FRUIT_CAP_G)
          flags.push({ item: item.name, issue: 'over ' + ME.FRUIT_CAP_G + 'g fruit cap' });
      }
      if (item.cooking_method && ME.COOKING_METHODS.not_allowed.some(m => String(item.cooking_method).toLowerCase().includes(m.toLowerCase())))
        flags.push({ item: item.name, issue: 'cooking method not allowed (uses fat)' });
    }
    if ((+(body.macros || {}).fat || 0) > 0) flags.push({ item: 'total', issue: 'Activation = zero added fat' });
    return { valid: flags.length === 0, flags };
  }

  if (sub === 'save') {
    const rows = body.rows || [];
    if (!rows.length) return { error: 'rows required' };
    const stmts = rows.map(r =>
      db.prepare('INSERT INTO meal_plans (user_id, day, meal, recipe, kcal, protein, fat, carbs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, +r.day, r.meal || '', r.recipe || '', Math.round(+r.kcal || 0), Math.round(+r.protein || 0), Math.round(+r.fat || 0), Math.round(+r.carbs || 0))
    );
    await db.batch(stmts);
    return { ok: true, saved: rows.length };
  }

  if (sub === 'users') {
    const rows = await db.prepare('SELECT id, name FROM users').all();
    return { users: rows.results };
  }

  return { error: 'unknown mealengine sub: ' + sub };
}

// ─── AI proxies (estimate, foodcheck, shoplist) ──────────────
async function estimateMeal(userId, body, db, env) {
  const url = env.AI_WORKER_URL || AI_WORKER_DEFAULT;
  const phase = String(body.phase || 'activation').toLowerCase();
  const policy = await getPolicyText(phase, db);

  const workerBody = { action: 'estimate', phase, description: body.description || '', policy };
  if (body.image) workerBody.image = body.image;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(workerBody)
  });
  try {
    const data = await res.json();
    if (data.error) return { error: data.error, detail: data.detail || '' };
    return data;
  } catch {
    return { error: 'worker parse error' };
  }
}

async function foodCheck(body, db, env) {
  const key = env.ANTHROPIC_KEY;
  if (!key) return { error: 'no key set' };
  const food = String(body.food || '').trim();
  if (!food) return { error: 'no food' };

  const phase = String(body.phase || 'activation').toLowerCase();
  const policy = await getPolicyText(phase, db);

  const rulesBlock = policy
    ? ('PHASE RULES (judge the food against these):\n' + policy + '\n')
    : 'You classify a single food for the AEVUM Activation diet (a protein-sparing modified fast). ';

  const sys =
    'You classify a single food for the AEVUM program. ' +
    'Judge the food per 100g, raw. Identify the food correctly. ' +
    'Return ONLY strict JSON, no prose: ' +
    '{"food":string,"verdict":"yes"|"limited"|"no","reason":string,"cap":string}. ' +
    rulesBlock +
    'field "reason" = max 8 words. field "cap" = for LIMITED only, a sensible max amount; empty string for yes/no.';

  const payload = {
    model: HAIKU_MODEL, max_tokens: 160, system: sys,
    messages: [{ role: 'user', content: 'Food: ' + food }]
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.content) return { error: 'ai error', detail: data };
  let txt = data.content.map(c => c.text || '').join('').trim().replace(/```json|```/g, '').trim();
  try {
    const j = JSON.parse(txt);
    return { food: j.food || food, verdict: j.verdict || 'limited', reason: j.reason || '', cap: j.cap || '' };
  } catch { return { error: 'parse', raw: txt }; }
}

async function shopList(body, env) {
  const key = env.ANTHROPIC_KEY;
  if (!key) return { error: 'no key set' };
  const ingredients = body.ingredients || [];
  if (!ingredients.length) return { items: [] };

  const sys =
    'You build a grocery shopping list. Merge duplicates, sum quantities. ' +
    'For dish names, infer main ingredients. Merge different names for same item. Ignore water, salt, pepper. ' +
    'Return ONLY strict JSON: {"groups":[{"category":string,"items":[{"name":string,"qty":string}]}]}. ' +
    'Categories: Protein, Vegetables, Fruit, Pantry/Other.';

  const payload = {
    model: HAIKU_MODEL, max_tokens: 1200, system: sys,
    messages: [{ role: 'user', content: 'Ingredients:\n' + ingredients.join('\n') }]
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.content) return { error: 'ai error', detail: data };
  let txt = data.content.map(c => c.text || '').join('').trim().replace(/```json|```/g, '').trim();
  try { return JSON.parse(txt); } catch { return { error: 'parse', raw: txt }; }
}

// ─── Admin routes ────────────────────────────────────────────
async function adminUsers(db) {
  const rows = await db.prepare(
    `SELECT u.id, u.name, u.email, u.program, u.created_at, u.current_target_kcal, u.start_weight,
      (SELECT COUNT(*) FROM daily_logs WHERE user_id = u.id) as log_count,
      (SELECT MAX(day) FROM daily_logs WHERE user_id = u.id) as last_day
    FROM users u ORDER BY u.created_at DESC`
  ).all();
  return { users: rows.results };
}

async function adminExport(body, db) {
  const targetId = String(body.id || '').toLowerCase();
  if (!targetId) return { error: 'id required' };
  const logs = await db.prepare('SELECT * FROM daily_logs WHERE user_id = ? ORDER BY day').bind(targetId).all();
  const plans = await db.prepare('SELECT * FROM meal_plans WHERE user_id = ? ORDER BY day').bind(targetId).all();
  const prof = await getProfile(targetId, db);
  return { profile: prof.profile, logs: logs.results, meal_plans: plans.results };
}

async function adminSeed(body, db) {
  const table = String(body.table || '');
  const rows = body.rows || [];
  if (!table || !rows.length) return { error: 'table and rows required' };

  const allowed = ['recipes', 'messages', 'movements', 'workouts', 'rules', 'foods', 'policy', 'config'];
  if (!allowed.includes(table)) return { error: 'table not allowed: ' + table };

  // Clear existing + insert
  const stmts = [db.prepare(`DELETE FROM ${table}`)];
  for (const row of rows) {
    const keys = Object.keys(row);
    const placeholders = keys.map(() => '?').join(', ');
    stmts.push(
      db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`)
        .bind(...keys.map(k => row[k] ?? null))
    );
  }
  await db.batch(stmts);
  return { ok: true, inserted: rows.length };
}
