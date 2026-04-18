# BDM App - Onboarding Guide

Welcome! This doc gets you from zero to running BDM App locally in ~10 minutes.

---

## What is BDM App?

**BDM** = Bosques del Mundo Bolivia

A document processing pipeline that uses AI (Google Gemini) to generate annual reports from PDF/DOCX files uploaded by partner organizations.

**Tech stack:**
- Frontend: Vite + React 19
- Backend: Express.js (Node.js)
- AI: Google Gemini API
- Deploy: Railway
- Testing: Vitest

---

## 1. Setup (First Time Only)

### 1.1 Prerequisites
- Node.js 18+ (check: `node --version`)
- npm 9+ (check: `npm --version`)
- Git

### 1.2 Clone the repo
```bash
git clone https://github.com/ruddyribera-ops/bdm-app.git
cd bdm-app
```

### 1.3 Install dependencies
```bash
npm install
```

### 1.4 Get environment variables
Ask a team member for the values, then create `.env`:
```bash
cp .env.example .env
# Edit .env and fill in the actual values
```

**Required variables:**
- `APP_PASSWORD` — Main app password (get from team)
- `GEMINI_API_KEY` — Google AI API key (get from Google AI Studio)
- `APP_SECRET` — HMAC signing secret (any random string works)

**Optional (defaults work for local dev):**
- `PORT=3000`
- `NODE_ENV=development`

### 1.5 Start dev server
```bash
npm run dev
```
Opens at: http://localhost:5173

### 1.6 Verify it works
```bash
# App should load in browser
# Login with the APP_PASSWORD you set

# Or test via curl:
curl -X POST http://localhost:3000/api/auth \
  -H "Content-Type: application/json" \
  -d '{"password":"YOUR_PASSWORD"}'
# Should return: { "token": "..." }
```

---

## 2. Project Structure

```
bdm-app/
├── src/
│   ├── App.jsx              # Main app component (~450 lines)
│   ├── components/         # Extracted React components
│   │   ├── index.js
│   │   ├── Editor.jsx       # Markdown editor/preview
│   │   ├── DropZone.jsx     # File upload area
│   │   ├── FileRow.jsx      # Uploaded file row
│   │   ├── MCard.jsx        # Partner card
│   │   ├── PasswordGate.jsx # Login screen
│   │   ├── StickyNote.jsx   # Chat message bubble
│   │   └── TemplateRow.jsx  # Template file row
│   ├── services/
│   │   ├── api.js           # Gemini API calls
│   │   └── fileParser.js    # PDF/DOCX extraction
│   ├── theme/
│   │   └── index.js         # Colors, sizing constants
│   ├── prompts/
│   │   └── index.js         # AI prompt templates
│   └── utils/
│       ├── auth.js          # Token management
│       └── exportHelpers.js  # Word/Markdown export
├── server.js                # Express API server
├── api/
│   └── utils/
│       └── rateLimiter.js   # Shared rate limiting
├── tests/                   # Vitest unit tests
├── docs/
│   ├── REFACTOR_BASELINE.md # Architecture decisions
│   ├── ROLLBACK_RUNBOOK.md # How to recover from bad deploy
│   └── REQUIRED_VARS.md    # Env vars reference
├── scripts/
│   └── backup-config.ps1   # Config backup script
└── .github/
    └── workflows/
        └── ci.yml          # GitHub Actions CI pipeline
```

---

## 3. Common Tasks

### Run tests
```bash
npm run test:run     # Run all tests once
npm run test         # Run in watch mode
npm run test:coverage # With coverage report
```

### Run lint
```bash
npm run lint         # Check for errors
```

### Build for production
```bash
npm run build        # Creates dist/ folder
npm run server       # Serve production build
```

### Run locally (dev mode)
```bash
npm run dev          # Vite dev server (port 5173)
# In another terminal:
npm run server       # Express API (port 3000)
```

---

## 4. How the App Works

### Login
User enters `APP_PASSWORD` → server validates → returns HMAC-SHA256 token → stored in sessionStorage.

### Document Processing Pipeline
1. User uploads **template file** (past annual report - PDF/DOCX)
2. User uploads **partner documents** (PDF/DOCX - multiple)
3. Click "Run Pipeline" → 8-step AI process:
   - `T` — Extract template structure
   - `Alpha` — Extract data from each partner doc
   - `M0a` — Consolidate all data
   - `M0b` — Generate narrative text
   - `M0c` — Add traceability
   - `M2` — Create executive dashboard
4. User edits generated report in the **Editor** component
5. Export to **Word** or **Markdown**

### Key Files
| File | Purpose |
|------|---------|
| `src/prompts/index.js` | All AI prompt templates |
| `src/services/api.js` | `callMotor()` - Gemini API calls |
| `src/services/fileParser.js` | `readFile()` - PDF/DOCX text extraction |
| `server.js` | Express routes: `/api/auth`, `/api/generate`, `/api/health` |

---

## 5. Making Changes

### Branch naming
```
feat/short-description   # New features
fix/short-description    # Bug fixes
refactor/short-desc      # Code restructuring
test/short-desc          # Adding tests
```

### Commit style
```
feat: add dark mode toggle
fix: correct rate limit header
refactor: extract Editor component
test: add auth token tests
```

### Pull requests
1. Create branch from `master`
2. Make changes
3. Ensure `npm run lint` and `npm run test:run` pass
4. Open PR → CI runs automatically
5. Merge to `master` → Railway auto-deploys

---

## 6. Getting Help

| Issue | Where to look |
|-------|--------------|
| App crashes on deploy | `docs/ROLLBACK_RUNBOOK.md` |
| Need env var values | Ask team lead |
| Don't understand a component | Ask in PR review |
| Found a bug | Open an issue or create `fix/` branch |

---

## 7. Important Rules

- **Never commit `.env`** — contains secrets
- **Never push to `master` without running tests** — CI will catch it, but still
- **Test locally before pushing** — saves time on CI feedback loop
- **If prod breaks, rollback first** — fix later (see `ROLLBACK_RUNBOOK.md`)

---

*Questions? Ask the team lead or open an issue on GitHub.*
*Last updated: 2026-04-18*
