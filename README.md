# Git Launchpad

**One-click preview deployments for any GitHub repository.** Paste a repo URL, get a live preview in seconds — powered by AI-driven stack detection and Docker containers.

![License](https://img.shields.io/badge/license-MIT-blue)

---

## Overview

Git Launchpad analyzes any GitHub repository, auto-detects its tech stack, provisions companion services (databases, caches), builds a Docker container, and serves a live preview URL — all without configuration.

### Key Features

- 🔍 **AI Stack Detection** — Automatically identifies language, framework, and dependencies
- 🐳 **Docker Isolation** — Every deployment runs in its own container with resource limits
- 🗄️ **Companion Services** — Auto-provisions MySQL, PostgreSQL, MongoDB, Redis when needed
- 🔧 **AI Auto-Fix** — Failed builds are automatically diagnosed and retried (up to 3 attempts)
- 📡 **Real-time Logs** — WebSocket-based live log streaming during build and runtime
- ⏱️ **TTL Management** — Configurable container lifetimes with automatic cleanup
- 🔐 **Google OAuth** — Secure authentication via Lovable Cloud

---

## Architecture

```
┌─────────────────┐     HTTPS      ┌──────────────────┐     Docker     ┌──────────────┐
│  React Frontend │ ──────────────▶│  FastAPI Backend  │ ─────────────▶│  Containers  │
│  (Vite + TS)    │                │  (Caddy reverse)  │               │  (previews)  │
└────────┬────────┘                └────────┬─────────┘               └──────────────┘
         │                                  │
         │  Auth + DB                       │  AI Analysis
         ▼                                  ▼
┌─────────────────┐                ┌──────────────────┐
│  Lovable Cloud  │                │  Edge Functions   │
│  (Supabase)     │                │  (analyze-repo)   │
└─────────────────┘                └──────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui, Framer Motion |
| **Backend** | Python 3.10+, FastAPI, Docker SDK (`docker-py`), Uvicorn |
| **Database & Auth** | Lovable Cloud (Supabase) — PostgreSQL, Google OAuth |
| **AI** | Gemini via Edge Functions — repo analysis & build error fixing |
| **Reverse Proxy** | Caddy (auto HTTPS, gzip, rate limiting) |
| **Containerization** | Docker with BuildKit, isolated bridge networks |

---

## Quick Start (Local Development)

### Frontend

```bash
# Clone the repo
git clone https://github.com/your-user/git-launchpad.git
cd git-launchpad

# Install dependencies
npm install

# Create .env (see docs/FRONTEND_DEPLOYMENT.md for all variables)
cp .env.example .env

# Start dev server
npm run dev
```

### Backend

```bash
cd backend

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Start the API server
python main.py
# → http://localhost:8000
```

> **Prerequisites:** Node.js ≥ 18, Python ≥ 3.10, Docker with BuildKit

---

## Deployment Guides

| Guide | Description |
|-------|-------------|
| [Frontend Deployment](docs/FRONTEND_DEPLOYMENT.md) | Build, deploy, and serve the React frontend |
| [Backend Deployment](docs/BACKEND_DEPLOYMENT.md) | VPS setup, systemd, Caddy, security hardening |
| [Backend README](backend/README.md) | API reference and endpoint documentation |

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/deploy` | Start a new deployment |
| `GET` | `/api/deploy/{id}` | Get deployment status |
| `DELETE` | `/api/deploy/{id}` | Stop and destroy a deployment |
| `WS` | `/ws/logs/{id}` | Real-time log streaming |

### Deploy Request Body

```json
{
  "repo_url": "https://github.com/user/repo",
  "env_vars": { "KEY": "value" },
  "ttl_minutes": 20,
  "deploy_config": {
    "language": "Python",
    "framework": "FastAPI",
    "install_cmd": "pip install -r requirements.txt",
    "build_cmd": "",
    "start_cmd": "uvicorn app:app --host 0.0.0.0 --port 8000",
    "port": 8000,
    "dockerfile_content": "FROM python:3.12-slim...",
    "detected_services": ["mysql"],
    "confidence": 85,
    "confidence_notes": "Detected requirements.txt with fastapi"
  }
}
```

---

## Environment Variables

### Frontend (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_API_BASE_URL` | Yes | Backend API URL (e.g., `https://api.yourdomain.com`) |
| `VITE_SUPABASE_URL` | Auto | Lovable Cloud project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Auto | Lovable Cloud anon key |

### Backend (Edge Function Secrets)

| Secret | Description |
|--------|-------------|
| `LOVABLE_API_KEY` | AI model access for repo analysis |
| `GITHUB_TOKEN` | GitHub API authentication (higher rate limits) |
| `SUPABASE_URL` | Lovable Cloud project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key for platform services |

---

## Database Schema

| Table | Purpose |
|-------|---------|
| `profiles` | User profiles (display name, avatar, email) |
| `deployments` | Deployment history and status tracking |
| `platform_services` | Companion service configurations (DB, cache) |

---

## Container Lifecycle

```
Paste URL → AI Analysis → Clone Repo → Detect Services
    → Start Companions → Build Docker Image → Run Container
    → Health Check → Live Preview URL → TTL Countdown → Cleanup
```

- **Free**: 20-minute container lifetime
- **Premium**: 60-minute lifetime
- **Elite**: Unlimited (no auto-cleanup)

Failed builds trigger an AI auto-fix loop (up to 3 retries) that patches the Dockerfile and environment.

---

## Security

- Google OAuth via Lovable Cloud (no password storage)
- Row-Level Security (RLS) on all database tables
- Container resource limits: 512 MB RAM, 1.0 CPU
- Isolated Docker bridge networks per deployment
- Caddy auto-HTTPS with Let's Encrypt
- CORS configured on both frontend and backend
- Firewall rules restricting exposed ports

---

## License

MIT
