# Frontend Deployment Guide

Git Launchpad frontend — React + Vite + TypeScript + Tailwind CSS.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Variables](#environment-variables)
3. [Build for Production](#build-for-production)
4. [Deploy Options](#deploy-options)
5. [Custom Domain Setup](#custom-domain-setup)
6. [Caddy as Frontend Server](#caddy-as-frontend-server)
7. [Authentication Setup](#authentication-setup)
8. [Edge Functions](#edge-functions)
9. [Performance Optimization](#performance-optimization)
10. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Node.js** ≥ 18 (recommended: 20 LTS)
- **npm** or **bun** (bun recommended for speed)
- A Lovable Cloud project (provides database and authentication)
- Backend API running (see [Backend Deployment](BACKEND_DEPLOYMENT.md))

---

## Environment Variables

Create a `.env` file in the project root:

```env
VITE_API_BASE_URL="https://api.yourdomain.com"
VITE_SUPABASE_URL="https://your-project.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="your-anon-key"
VITE_SUPABASE_PROJECT_ID="your-project-id"
```

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_API_BASE_URL` | **Yes** | Backend API URL (your VPS or domain). No trailing slash. |
| `VITE_SUPABASE_URL` | Auto | Lovable Cloud project URL (auto-configured in Lovable) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Auto | Public anon key — safe to expose in client code |
| `VITE_SUPABASE_PROJECT_ID` | Auto | Project identifier (auto-configured in Lovable) |

> **Security Note:** The `VITE_SUPABASE_PUBLISHABLE_KEY` is the **anon key** — it's designed to be public. Row-Level Security (RLS) policies protect your data, not the key.

---

## Build for Production

```bash
# Install dependencies
npm install
# or
bun install

# Type-check (optional but recommended)
npx tsc --noEmit

# Build
npm run build
# or
bun run build

# Preview build locally
npm run preview
```

Output goes to the `dist/` folder. This is a static SPA — it can be hosted anywhere that serves static files.

### Build output structure

```
dist/
├── index.html          # Entry point
├── assets/
│   ├── index-[hash].js # Main JS bundle
│   └── index-[hash].css # Compiled CSS
└── ...                 # Static assets (favicon, robots.txt, etc.)
```

---

## Deploy Options

### Option 1: Lovable (Recommended)

Click **Publish** in Lovable — done.

- ✅ Automatic builds on every change
- ✅ Preview URLs for sharing
- ✅ Custom domain support
- ✅ Edge CDN for fast loading
- ✅ Environment variables auto-configured

### Option 2: Vercel

```bash
npm i -g vercel
vercel --prod
```

Set environment variables in **Vercel Dashboard → Settings → Environment Variables**.

**Important Vercel settings:**
- Framework Preset: `Vite`
- Build Command: `npm run build`
- Output Directory: `dist`
- Node.js Version: `20.x`

### Option 3: Netlify

1. Push to GitHub
2. Connect repo in Netlify
3. Configure:
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
4. Add environment variables in **Site settings → Environment variables**
5. Add a `_redirects` file to `public/`:
   ```
   /* /index.html 200
   ```
   This ensures client-side routing works correctly.

### Option 4: Self-hosted VPS

```bash
# Build locally
npm run build

# Upload to VPS
rsync -avz --delete dist/ user@your-server:/var/www/gitlaunchpad/

# Or via scp
scp -r dist/* user@your-server:/var/www/gitlaunchpad/
```

### Option 5: Docker (containerized frontend)

Create a `Dockerfile.frontend` in the project root:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM caddy:2-alpine
COPY --from=builder /app/dist /srv
COPY <<EOF /etc/caddy/Caddyfile
:80 {
    root * /srv
    file_server
    try_files {path} /index.html
    encode gzip
}
EOF
EXPOSE 80
```

```bash
docker build -f Dockerfile.frontend -t gitlaunchpad-frontend .
docker run -d -p 3000:80 gitlaunchpad-frontend
```

---

## Custom Domain Setup

### DNS Configuration

Add these records at your domain registrar:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | `@` | `your-server-ip` | 300 |
| CNAME | `www` | `yourdomain.com` | 300 |

### With Lovable

1. Go to **Project → Settings → Domains**
2. Add your custom domain
3. Update DNS records as shown
4. SSL is automatic

### With Vercel / Netlify

Both platforms provide guided domain setup wizards with automatic SSL.

### Verify DNS

```bash
dig yourdomain.com +short
# Should return your server IP

dig www.yourdomain.com +short
# Should return yourdomain.com (CNAME)
```

---

## Caddy as Frontend Server

If self-hosting on a VPS, Caddy serves the static files with automatic HTTPS, compression, and security headers.

### Install Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

### Caddyfile (`/etc/caddy/Caddyfile`)

**With a domain (auto HTTPS):**

```caddy
yourdomain.com {
    root * /var/www/gitlaunchpad
    file_server
    try_files {path} /index.html

    header {
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.yourdomain.com wss://api.yourdomain.com;"
    }

    # Cache static assets aggressively
    @static path *.js *.css *.png *.jpg *.svg *.woff2 *.ico
    header @static Cache-Control "public, max-age=31536000, immutable"

    encode gzip zstd
}
```

**Without a domain (self-signed cert on IP):**

```caddy
:443 {
    tls internal
    root * /var/www/gitlaunchpad
    file_server
    try_files {path} /index.html
    encode gzip
}
```

### Key Configuration Notes

| Directive | Purpose |
|-----------|---------|
| `try_files {path} /index.html` | **Required** — SPA routing (React Router) |
| `encode gzip zstd` | Compresses responses (40-70% size reduction) |
| `Cache-Control immutable` | Vite hashed assets never change — cache forever |
| `Strict-Transport-Security` | Forces HTTPS for all future requests |
| `Content-Security-Policy` | Restricts resource loading to trusted origins |

### Upload build files and start

```bash
# Create directory
sudo mkdir -p /var/www/gitlaunchpad

# Copy built files
sudo cp -r dist/* /var/www/gitlaunchpad/
sudo chown -R caddy:caddy /var/www/gitlaunchpad

# Start Caddy
sudo systemctl enable caddy
sudo systemctl restart caddy
sudo systemctl status caddy
```

---

## Authentication Setup

Git Launchpad uses **Google OAuth** via Lovable Cloud. This is pre-configured when using Lovable.

### For self-hosted deployments

1. Create a Google OAuth app at [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Set **Authorized redirect URIs** to:
   - `https://your-supabase-project.supabase.co/auth/v1/callback`
3. Configure the OAuth credentials in your Lovable Cloud authentication settings
4. Update the frontend's redirect URL in `AuthContext.tsx` if using a custom domain

### Auth flow

```
User clicks "Sign in with Google"
  → Redirect to Google OAuth consent screen
  → Google redirects back to Supabase auth callback
  → Supabase creates/updates user + profile
  → Frontend receives session token
  → User sees dashboard
```

---

## Edge Functions

The project includes two edge functions deployed automatically via Lovable Cloud:

### `analyze-repo`

Analyzes a GitHub repository to generate deployment configuration:
- Fetches repo file tree from GitHub API
- Reads configuration files (package.json, requirements.txt, etc.)
- Uses AI (Gemini) to generate Dockerfile and detect stack
- Matches environment variables to platform services

### `fix-deploy-error`

AI-powered build error fixer:
- Receives failed build logs and current Dockerfile
- Uses AI to diagnose the issue
- Returns patched Dockerfile and environment changes

### Required secrets for edge functions

These are configured in Lovable Cloud (auto-configured for Lovable projects):

| Secret | Purpose |
|--------|---------|
| `LOVABLE_API_KEY` | AI model access (Gemini) |
| `GITHUB_TOKEN` | GitHub API authentication for higher rate limits |

---

## Performance Optimization

### Vite build optimizations (already configured)

- **Code splitting:** React lazy imports split routes into separate chunks
- **Tree shaking:** Unused code is automatically removed
- **Asset hashing:** Cache-busting via content hashes in filenames
- **CSS purging:** Tailwind removes unused styles in production

### Additional optimizations

1. **Preconnect to external origins** — Already configured in `index.html`:
   ```html
   <link rel="preconnect" href="https://fonts.googleapis.com" />
   ```

2. **Image optimization** — Use WebP format, lazy loading (`loading="lazy"`)

3. **Bundle analysis:**
   ```bash
   npx vite-bundle-visualizer
   ```

---

## Troubleshooting

### Build fails

```bash
# Clear cache and reinstall
rm -rf node_modules dist
npm install
npm run build

# Check TypeScript errors
npx tsc --noEmit
```

### Blank page after deploy

- Check browser console for errors
- Verify `try_files {path} /index.html` is in your Caddy/Nginx config
- Ensure all environment variables are set
- Check that `VITE_API_BASE_URL` points to the correct backend

### Authentication not working

- Verify Google OAuth redirect URIs include your domain
- Check that `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are set
- Look at browser Network tab for failed auth requests
- Ensure the backend Lovable Cloud auth settings have Google OAuth enabled

### API connection errors

- Check `VITE_API_BASE_URL` is correct (no trailing slash)
- Verify CORS headers are set on the backend
- Check for mixed content (HTTPS frontend → HTTP backend is blocked)
- Test backend directly: `curl https://api.yourdomain.com/docs`

### WebSocket logs not streaming

- WebSocket uses `wss://` when `VITE_API_BASE_URL` starts with `https://`
- Caddy automatically handles WebSocket upgrades
- Check browser console for WebSocket connection errors
- The frontend has auto-reconnect (3 attempts with backoff)
