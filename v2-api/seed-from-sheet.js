/**
 * Seed script: export data from your Google Sheet and push to D1 via admin API.
 *
 * Usage:
 *   1. Export each Sheet tab as CSV (File > Download > CSV)
 *   2. Run: node seed-from-sheet.js <worker-url> <admin-token>
 *
 * This script reads CSV files from a ./csv/ folder and POSTs them to the admin_seed endpoint.
 * Expected CSV files (named exactly):
 *   Rules.csv, Messages.csv, Recipes.csv, Movements.csv, Workouts.csv,
 *   Foods.csv, Policy.csv, Config.csv
 */

const fs = require('fs');
const path = require('path');

const WORKER_URL = process.argv[2];
const ADMIN_TOKEN = process.argv[3];

if (!WORKER_URL || !ADMIN_TOKEN) {
  console.error('Usage: node seed-from-sheet.js <worker-url> <admin-token>');
  process.exit(1);
}

const CSV_DIR = path.join(__dirname, 'csv');

// Simple CSV parser (handles quoted fields)
function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    const obj = {};
    headers.forEach((h, j) => {
      const key = h.trim().toLowerCase();
      if (key) obj[key] = (vals[j] || '').trim();
    });
    rows.push(obj);
  }
  return rows;
}

function parseLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// Table name mapping (CSV filename → D1 table)
const TABLE_MAP = {
  'Rules': 'rules',
  'Messages': 'messages',
  'Recipes': 'recipes',
  'Movements': 'movements',
  'Workouts': 'workouts',
  'Foods': 'foods',
  'Policy': 'policy',
  'Config': 'config'
};

// Column mapping per table (Sheet header → D1 column)
const COL_MAP = {
  rules: { phase: 'phase', model: 'model', metric: 'metric', basis: 'basis', value: 'value', green_lo: 'green_lo', green_hi: 'green_hi', amber_lo: 'amber_lo', amber_hi: 'amber_hi', gated: 'gated', unit: 'unit' },
  messages: { id: 'id', trigger: 'trigger', enabled: 'enabled', phase: 'phase', priority: 'priority', title: 'title', body: 'body', badge: 'badge', frequency: 'frequency' },
  recipes: { name: 'name', protein: 'protein', cuisine: 'cuisine', phase: 'phase', kcal: 'kcal', protein_g: 'protein_g', fat_g: 'fat_g', carbs_g: 'carbs_g', ingredients: 'ingredients', steps: 'steps' },
  movements: { id: 'id', name: 'name', phase: 'phase', equipment: 'equipment', video_url: 'video_url', cues: 'cues', mistake: 'mistake' },
  workouts: { workout_id: 'workout_id', workout_name: 'workout_name', phase: 'phase', duration_min: 'duration_min', order: 'sort_order', movement_id: 'movement_id', sets: 'sets', reps: 'reps', rest_sec: 'rest_sec' },
  foods: { phase: 'phase', category: 'category', subcategory: 'subcategory', item: 'item', verdict: 'verdict', cap_g: 'cap_g', note: 'note' },
  policy: { phase: 'phase', rules_text: 'rules_text' },
  config: { key: 'key', value: 'value' }
};

const NUMERIC_COLS = new Set([
  'value', 'green_lo', 'green_hi', 'amber_lo', 'amber_hi',
  'priority', 'kcal', 'protein_g', 'fat_g', 'carbs_g', 'cap_g',
  'duration_min', 'sort_order', 'sets', 'reps', 'rest_sec'
]);

async function seedTable(csvName, tableName) {
  const filePath = path.join(CSV_DIR, csvName + '.csv');
  if (!fs.existsSync(filePath)) {
    console.log(`  SKIP ${csvName}.csv (not found)`);
    return;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const rawRows = parseCSV(text);
  const colMap = COL_MAP[tableName];

  const rows = rawRows.map(raw => {
    const mapped = {};
    for (const [sheetCol, dbCol] of Object.entries(colMap)) {
      let val = raw[sheetCol] !== undefined ? raw[sheetCol] : (raw[dbCol] || '');
      if (NUMERIC_COLS.has(dbCol) && val !== '') {
        const n = parseFloat(val);
        val = isNaN(n) ? null : n;
      }
      mapped[dbCol] = val === '' ? null : val;
    }
    return mapped;
  }).filter(r => {
    // skip empty rows
    const vals = Object.values(r).filter(v => v != null && v !== '');
    return vals.length > 0;
  });

  console.log(`  Seeding ${tableName}: ${rows.length} rows`);

  const res = await fetch(WORKER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + ADMIN_TOKEN
    },
    body: JSON.stringify({ action: 'admin_seed', table: tableName, rows })
  });
  const data = await res.json();
  if (data.error) console.error(`  ERROR: ${data.error}`);
  else console.log(`  OK: ${data.inserted} inserted`);
}

async function main() {
  console.log('Seeding AEVUM D1 from CSV exports...\n');
  for (const [csvName, tableName] of Object.entries(TABLE_MAP)) {
    await seedTable(csvName, tableName);
  }
  console.log('\nDone.');
}

main().catch(console.error);
