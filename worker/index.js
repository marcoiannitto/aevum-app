/**
 * AEVUM API Proxy Worker v1.0.0
 *
 * Sits between the frontend and Google Apps Script.
 * - Hides the GAS URL from the client
 * - Enforces CORS (only app.niramaya.sg)
 * - Validates request shape before forwarding
 * - Basic rate limiting per IP (60 req/min)
 */

// Allowed GAS actions (whitelist)
const ALLOWED_ACTIONS = new Set([
  'config', 'messages', 'profile', 'register', 'rules',
  'sync', 'settarget', 'savetarget', 'getdays',
  'mealplan', 'recipes', 'fitness', 'graduation'
]);

// Simple in-memory rate limiter (per-isolate, best effort)
const rateMap = new Map();
const RATE_LIMIT = 60;      // requests
const RATE_WINDOW = 60000;  // per minute

function rateCheck(ip) {
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    entry = { start: now, count: 0 };
    rateMap.set(ip, entry);
  }
  entry.count++;
  // Prune old entries periodically
  if (rateMap.size > 10000) {
    for (const [k, v] of rateMap) {
      if (now - v.start > RATE_WINDOW) rateMap.delete(k);
    }
  }
  return entry.count <= RATE_LIMIT;
}

function corsHeaders(origin, allowed) {
  // Allow localhost for development
  const isAllowed = origin === allowed
    || origin === 'http://localhost:8080'
    || origin === 'http://127.0.0.1:8080';
  if (!isAllowed) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400'
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || 'https://app.niramaya.sg';
    const cors = corsHeaders(origin, allowed);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      if (!cors) return new Response('Forbidden', { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }

    // Only POST
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // CORS check
    if (!cors) {
      return new Response('Forbidden', { status: 403 });
    }

    // Rate limit
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!rateCheck(ip)) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // Parse body (frontend sends as text/plain or application/json)
    let body;
    try {
      const raw = await request.text();
      body = JSON.parse(raw);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // Validate action
    const action = body && body.action;
    if (!action || typeof action !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing action' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
    if (!ALLOWED_ACTIONS.has(action)) {
      return new Response(JSON.stringify({ error: 'Unknown action' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // Forward to GAS
    const gasUrl = env.GAS_URL;
    if (!gasUrl) {
      return new Response(JSON.stringify({ error: 'Backend not configured' }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    try {
      const gasRes = await fetch(gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body)
      });

      // GAS returns text/html with JSON content, pass it through
      const text = await gasRes.text();
      return new Response(text, {
        status: gasRes.status,
        headers: {
          ...cors,
          'Content-Type': 'application/json'
        }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Backend unreachable' }), {
        status: 502,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
  }
};
