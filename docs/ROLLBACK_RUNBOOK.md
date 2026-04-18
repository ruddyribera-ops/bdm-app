# BDM App - Rollback Runbook

**Applies to:** Railway production deployment
**URL:** https://bdm-app-prod-production.up.railway.app
**Repo:** https://github.com/ruddyribera-ops/bdm-app

---

## Scenario 1: Bad Deploy (App Crashes or Shows Wrong Behavior)

### Step 1: Confirm the problem
```bash
# Check if app responds
curl https://bdm-app-prod-production.up.railway.app/health

# Check Railway status
railway status

# View recent logs
railway logs --tail 50
```

### Step 2: Identify last good commit
```bash
# View recent commits
git log --oneline -10

# Find the last known good commit (before today's deploy)
git log --oneline --since="2 hours ago"
```

### Step 3: Rollback via Railway dashboard (fastest)
1. Go to: https://railway.app/project/bdm-app-prod
2. Navigate to **Deployments** tab
3. Find the last **Successful** deployment
4. Click **...** menu → **Redeploy**
5. Wait ~2 min for redeploy to complete

### Step 4: Verify rollback
```bash
# Confirm app is up
curl https://bdm-app-prod-production.up.railway.app/health

# Check the deployed commit matches what you expect
# (If you exposed RAILWAY_GIT_COMMIT_SHA in /api/health, check it)
curl https://bdm-app-prod-production.up.railway.app/api/health | jq .timestamp
```

---

## Scenario 2: Railway Console Access Lost (Can't Login)

### Step 1: Get access via Railway CLI
```bash
# Install Railway CLI (if not installed)
npm install -g @railway/cli

# Login
railway login

# Link to project
railway project link -p <project-id>

# Verify access
railway status
```

### Step 2: Check environment variables
```bash
# List all vars
railway env list

# If vars are missing, they were likely deleted accidentally
# See docs/REQUIRED_VARS.md for recovery steps
```

---

## Scenario 3: Database/State Loss

> **Note:** BDM App does **not** use a database. All state is in-browser (localStorage/sessionStorage).
> If a deploy breaks, user sessions are invalidated (they'll need to re-login).
> No persistent data is stored server-side.

### If this changes in the future:
- Add PostgreSQL backup: `railway run pg_dump -U postgres > backup.sql`
- Restore: `railway run psql -U postgres < backup.sql`

---

## Scenario 4: Environment Variables Accidentally Deleted

### Step 1: Check if Railway still has them
```bash
railway env list
```

### Step 2: Restore from backup
```bash
# If you ran scripts/backup-config.ps1 earlier:
# Your backup is in bdm-config-backup.txt

# Re-set each var:
railway env set APP_PASSWORD="your-value"
railway env set APP_SECRET="your-value"
railway env set GEMINI_API_KEY="your-value"
```

### Step 3: Redeploy to pick up new vars
```bash
railway up --detach
```

---

## Quick Reference: Railway CLI Commands

| Action | Command |
|--------|---------|
| View logs | `railway logs --tail 50` |
| Check status | `railway status` |
| List env vars | `railway env list` |
| Set env var | `railway env set KEY=value` |
| Remove env var | `railway env unset KEY` |
| Redeploy | `railway up --detach` |
| Rollback to previous | Railway Dashboard → Deployments → last good → Redeploy |

---

## Pre-Deploy Safety Checklist

Before any `git push` that triggers Railway deploy:

- [ ] Run `npm run lint` locally — no errors
- [ ] Run `npm run test:run` — all 35+ tests pass
- [ ] Run `npm run build` — builds successfully
- [ ] Check git log — know which commit is about to deploy
- [ ] Check Railway status — no ongoing incidents

## Post-Deploy Verification

After Railway deploys (auto-triggered by git push to `master`):

```bash
# Wait 30 seconds for Railway to roll the new build
sleep 30

# 1. Health check
curl https://bdm-app-prod-production.up.railway.app/health

# 2. API health (includes service status)
curl https://bdm-app-prod-production.up.railway.app/api/health

# 3. Smoke test login
curl -X POST https://bdm-app-prod-production.up.railway.app/api/auth \
  -H "Content-Type: application/json" \
  -d '{"password":"YOUR_PASSWORD"}'

# 4. Check logs for errors
railway logs --tail 20 | grep -i error
```

If any step fails → rollback immediately using Scenario 1.

---

*Last updated: 2026-04-18*
*Version: 1.0.0*
