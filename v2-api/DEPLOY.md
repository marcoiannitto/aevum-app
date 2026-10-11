# AEVUM API v2 - Deployment Guide

Run all commands from the `v2-api/` directory on your local machine.

## 1. Install wrangler (if not already)

```bash
npm install -g wrangler
wrangler login
```

## 2. Create the D1 database

```bash
npx wrangler d1 create aevum-db
```

Copy the `database_id` from the output and paste it into `wrangler.toml` (the `database_id = ""` line).

## 3. Run the schema migration

```bash
npx wrangler d1 execute aevum-db --remote --file=migrations/0001_init.sql
```

## 4. Set secrets

```bash
npx wrangler secret put ADMIN_TOKEN
# paste a strong password, e.g.: aevum_admin_2024_xyz

npx wrangler secret put AI_WORKER_URL
# paste: https://sweet-fire-a436.marco-iannitto.workers.dev/

npx wrangler secret put ANTHROPIC_KEY
# paste your Anthropic API key
```

## 5. Deploy the Worker

```bash
npx wrangler deploy
```

This deploys `aevum-api-v2` to Cloudflare. Note the URL it prints (e.g. `aevum-api-v2.<your-account>.workers.dev`).

## 6. Create your admin token

```bash
npx wrangler d1 execute aevum-db --remote --command="INSERT INTO auth_tokens (token, user_id, role) VALUES ('YOUR_ADMIN_TOKEN_HERE', 'marco', 'admin');"
```

Replace `YOUR_ADMIN_TOKEN_HERE` with the same value you set as `ADMIN_TOKEN` secret.

Also create your admin user row:

```bash
npx wrangler d1 execute aevum-db --remote --command="INSERT INTO users (id, name, program) VALUES ('marco', 'Marco', 1);"
```

## 7. Seed reference data

Use the admin API to seed your Rules, Messages, Recipes, etc. from the Google Sheet. I will provide a seed script separately.

## 8. DNS for beta.niramaya.sg

Add a CNAME record in your Cloudflare DNS:
- Type: CNAME
- Name: beta
- Target: marcoiannitto.github.io
- Proxy: OFF (DNS only, grey cloud)

This is for the frontend (GitHub Pages). The API Worker is accessed at its own `.workers.dev` URL.

## 9. Update frontend

The beta frontend needs two changes:
1. API URL points to the new Worker URL instead of the old proxy
2. Login screen + token storage in localStorage
3. All API calls include `Authorization: Bearer <token>` header

These changes go on a `v2-auth` branch deployed to `beta.niramaya.sg`.
