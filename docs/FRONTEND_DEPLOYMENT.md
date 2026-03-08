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

---

## Prerequisites

- **Node.js** ≥ 18
- **npm** or **bun** (bun recommended for speed)
- A VPS or hosting provider (Vercel, Netlify, or your own server)

---

## Environment Variables

Create a `.env` file in the project root:

```env
VITE_API_BASE_URL="https://your-backend-domain.com"
VITE_SUPABASE_URL="https://your-project.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="your-anon-key"
```

| Variable | Description |
|----------|-------------|
| `VITE_API_BASE_URL` | Backend API URL (your VPS or domain) |
| `VITE_SUPABASE_URL` | Lovable Cloud / Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Public anon key (safe to expose) |

---

## Build for Production

```bash
# Install dependencies
npm install
# or
bun install

# Build
npm run build
# or
bun run build
```

Output goes to `dist/` folder.

---

## Deploy Options

### Option 1: Lovable (Recommended)

Click "Publish" in Lovable — done. Automatic builds, preview URLs, and custom domains supported.

### Option 2: Vercel

```bash
npm i -g vercel
vercel --prod
```

Set environment variables in Vercel dashboard → Settings → Environment Variables.

### Option 3: Netlify

1. Push to GitHub
2. Connect repo in Netlify
3. Build command: `npm run build`
4. Publish directory: `dist`
5. Add environment variables in Site settings → Environment variables

### Option 4: Self-hosted VPS

```bash
# On your VPS
scp -r dist/* user@your-server:/var/www/gitlaunchpad/

# Or use rsync
rsync -avz dist/ user@your-server:/var/www/gitlaunchpad/
```

---

## Custom Domain Setup

### DNS Configuration

Add these records at your domain registrar:

| Type | Name | Value |
|------|------|-------|
| A | `@` | `your-server-ip` |
| CNAME | `www` | `yourdomain.com` |

### With Lovable

1. Go to **Settings → Domains** in your Lovable project
2. Add your custom domain
3. Update DNS records as shown

### With Vercel/Netlify

Follow their respective domain setup wizards — both handle SSL automatically.

---

## Caddy as Frontend Server

If self-hosting on a VPS, Caddy serves the static files AND provides automatic HTTPS.

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
        Referrer-Policy "strict-origin-when-cross-origin"
    }
    
    encode gzip
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

### Key Points

- `try_files {path} /index.html` — Required for SPA routing (React Router)
- `encode gzip` — Compresses responses for faster loading
- Caddy auto-renews SSL certificates when using a domain

### Start Caddy

```bash
sudo systemctl enable caddy
sudo systemctl restart caddy
sudo systemctl status caddy
```

### Upload Build Files

```bash
sudo mkdir -p /var/www/gitlaunchpad
sudo cp -r dist/* /var/www/gitlaunchpad/
sudo chown -R caddy:caddy /var/www/gitlaunchpad
```
