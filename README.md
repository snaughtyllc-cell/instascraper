# InstaScraper — Instagram Competitor Content Scraper & Review System

A web app for scraping viral Instagram reels from competitor accounts, storing them, and having your team browse + tag content for recreation.

## Quick Start (Local Dev)

```bash
# 1. Install all dependencies
npm run install:all

# 2. Copy and configure environment variables
cp .env.example .env
# Edit .env: add your Apify API key + set a team password

# 3. Seed the database with sample posts
npm run seed

# 4. Start both server and client (dev mode)
npm start
```

Dev mode runs at:
- **Frontend:** http://localhost:3000
- **API:** http://localhost:4000

## Production (Single Port)

```bash
npm run build        # Build React frontend
npm run production   # Serve everything on port 4000
```

Visit http://localhost:4000 — serves both the UI and API.

## Deploy to VPS

### Option A: Docker (Recommended)

```bash
# On your VPS:
git clone <your-repo> && cd instascraper
cp .env.example .env   # Edit with your keys
docker compose up -d   # Runs on port 4000
```

### Option B: Direct

```bash
# On your VPS (Ubuntu/Debian):
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

git clone <your-repo> && cd instascraper
cp .env.example .env   # Edit with your keys
npm run install:all
npm run build
npm run seed           # First time only

# Run with pm2 for auto-restart:
npm install -g pm2
pm2 start "npm run production" --name instascraper
pm2 save && pm2 startup
```

### Option C: Railway / Render

1. Push to GitHub
2. Connect repo on Railway or Render
3. Set env vars: `APIFY_API_KEY`, `AUTH_PASSWORD`, `SESSION_SECRET`, `PORT=4000`, `NODE_ENV=production`
4. Build command: `npm run install:all && npm run build`
5. Start command: `npm run production`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `APIFY_API_KEY` | Yes | Your Apify API key for Instagram scraping |
| `AUTH_PASSWORD` | Yes | Shared team password for login |
| `SESSION_SECRET` | Yes | Random string for session encryption |
| `PORT` | No | Server port (default: 4000) |

## Features

- **Reels-only scraping** via Apify's dedicated Instagram Reel Scraper
- **Filter** by minimum likes, views, date range, content type
- **Content Library** with grid view, thumbnail caching
- **Tag system**: Recreate, Reference, Skip
- **Creator + Video content types** (Talking, Dance, Skit, Snapchat, Omegle, OSC)
- **Archive system** to hide reviewed content
- **Staff notes** with auto-save
- **Export** tagged "Recreate" items as JSON
- **Password auth** for team access
- **Dark mode UI** with gold (#D4AF37) accent

## Tech Stack

- **Backend:** Node.js, Express, better-sqlite3, express-session
- **Frontend:** React, Tailwind CSS, Axios
- **Scraping:** Apify Instagram Reel Scraper API
- **Deploy:** Docker / PM2 / Railway / Render
