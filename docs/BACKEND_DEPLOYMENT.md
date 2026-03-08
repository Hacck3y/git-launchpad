# Backend Deployment Guide

Git Launchpad backend — FastAPI + Docker deployment engine on a VPS.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [VPS Setup](#vps-setup)
3. [Install Dependencies](#install-dependencies)
4. [Run the Backend](#run-the-backend)
5. [Systemd Service (Auto-start)](#systemd-service)
6. [Custom Domain Setup](#custom-domain-setup)
7. [Caddy as Reverse Proxy](#caddy-as-reverse-proxy)
8. [Security Hardening](#security-hardening)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **VPS** with Ubuntu 22.04+ (DigitalOcean, Hetzner, AWS, etc.)
- **Python** 3.10+
- **Docker** with BuildKit (`docker-buildx-plugin`)
- **Root or sudo access**
- At least **2 GB RAM** recommended

---

## VPS Setup

### 1. Update system

```bash
sudo apt update && sudo apt upgrade -y
```

### 2. Install Python

```bash
sudo apt install -y python3 python3-pip python3-venv
```

### 3. Install Docker

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Install BuildKit plugin (REQUIRED — legacy builder won't work)
sudo apt-get install -y docker-buildx-plugin

# Verify
docker --version
docker buildx version
```

### 4. Clone the backend

```bash
cd /opt
git clone https://github.com/your-user/your-repo.git gitlaunchpad
cd gitlaunchpad/backend
```

---

## Install Dependencies

```bash
cd /opt/gitlaunchpad/backend
pip install fastapi uvicorn pydantic
```

Or with a virtual environment:

```bash
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn pydantic
```

---

## Run the Backend

### Quick test

```bash
cd /opt/gitlaunchpad/backend
python3 main.py
# Runs on http://0.0.0.0:8000
```

### Verify

```bash
curl http://localhost:8000/
# Should return: {"detail":"Not Found"} — that's expected (no root route)

curl -X POST http://localhost:8000/api/deploy \
  -H "Content-Type: application/json" \
  -d '{"repo_url":"https://github.com/expressjs/express"}'
# Should return: {"deploy_id":"...","status":"cloning"}
```

---

## Systemd Service

Create a service so the backend auto-starts on boot and restarts on crash.

### Create service file

```bash
sudo nano /etc/systemd/system/gitlaunchpad.service
```

```ini
[Unit]
Description=Git Launchpad API
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/gitlaunchpad/backend
ExecStart=/usr/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

> If using a virtual environment, change `ExecStart` to:
> ```
> ExecStart=/opt/gitlaunchpad/backend/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
> ```

### Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable gitlaunchpad
sudo systemctl start gitlaunchpad
sudo systemctl status gitlaunchpad
```

### View logs

```bash
sudo journalctl -u gitlaunchpad -f
```

---

## Custom Domain Setup

### DNS Configuration

At your domain registrar, add:

| Type | Name | Value |
|------|------|-------|
| A | `api` | `your-vps-ip` |

Example: `api.yourdomain.com → 157.245.109.239`

### Update Frontend

After setting up the domain, update the frontend `.env`:

```env
VITE_API_BASE_URL="https://api.yourdomain.com"
```

Rebuild and redeploy the frontend.

---

## Caddy as Reverse Proxy

Caddy sits in front of FastAPI, handling HTTPS and proxying requests.

### Install Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

### Caddyfile (`/etc/caddy/Caddyfile`)

**With a domain (auto HTTPS — recommended):**

```caddy
api.yourdomain.com {
    reverse_proxy localhost:8000
    
    header {
        Access-Control-Allow-Origin *
        Access-Control-Allow-Methods "GET, POST, DELETE, OPTIONS"
        Access-Control-Allow-Headers "Content-Type, Authorization"
    }
}
```

Caddy automatically obtains and renews Let's Encrypt SSL certificates. No manual cert management needed.

**Without a domain (self-signed cert on bare IP):**

```caddy
:443 {
    tls internal
    reverse_proxy localhost:8000
}
```

> ⚠️ Browsers will show a security warning with self-signed certs. This is fine for development but not production.

**Both frontend + backend on one server:**

```caddy
yourdomain.com {
    root * /var/www/gitlaunchpad
    file_server
    try_files {path} /index.html
    encode gzip
}

api.yourdomain.com {
    reverse_proxy localhost:8000
}
```

### Start Caddy

```bash
sudo systemctl enable caddy
sudo systemctl restart caddy
sudo systemctl status caddy

# Check logs if something goes wrong
sudo journalctl -u caddy -f
```

### Firewall

Make sure ports 80 and 443 are open:

```bash
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

> Port 80 is needed for Caddy's ACME HTTP challenge (Let's Encrypt verification).

---

## Security Hardening

### 1. Firewall — only expose necessary ports

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
# Allow container preview ports
sudo ufw allow 10000:10100/tcp
sudo ufw enable
```

### 2. Don't run as root (optional but recommended)

Create a dedicated user:

```bash
sudo useradd -m -s /bin/bash gitlaunchpad
sudo usermod -aG docker gitlaunchpad
```

Update the systemd service `User=gitlaunchpad`.

### 3. Rate limiting with Caddy

```caddy
api.yourdomain.com {
    rate_limit {
        zone api_limit {
            key {remote_host}
            events 30
            window 1m
        }
    }
    reverse_proxy localhost:8000
}
```

> Note: Rate limiting requires the `caddy-ratelimit` plugin.

---

## Troubleshooting

### Backend won't start

```bash
# Check if port 8000 is already in use
sudo lsof -i :8000

# Check service logs
sudo journalctl -u gitlaunchpad --no-pager -n 50
```

### Docker build fails

```bash
# Make sure buildx is installed
docker buildx version

# If not installed:
sudo apt-get install -y docker-buildx-plugin

# Check Docker is running
sudo systemctl status docker
```

### Caddy won't start

```bash
# Validate Caddyfile syntax
caddy validate --config /etc/caddy/Caddyfile

# Check logs
sudo journalctl -u caddy --no-pager -n 50

# Common issue: port 80/443 already in use (Nginx?)
sudo lsof -i :80
sudo lsof -i :443
```

### Container previews not accessible

```bash
# Check if container is running
docker ps

# Check container logs
docker logs <container-id>

# Make sure preview ports are open in firewall
sudo ufw status
```

### SSL certificate issues

- **With domain**: Caddy handles it automatically. Make sure DNS A record points to your VPS IP and ports 80+443 are open.
- **Without domain**: Use `tls internal` for self-signed certs. Browsers will warn — this is expected.
