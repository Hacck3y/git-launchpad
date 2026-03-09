# Backend Deployment Guide

Git Launchpad backend — FastAPI + Docker deployment engine on a VPS.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [VPS Setup](#vps-setup)
3. [Install Dependencies](#install-dependencies)
4. [Configuration](#configuration)
5. [Run the Backend](#run-the-backend)
6. [Systemd Service (Auto-start)](#systemd-service)
7. [Custom Domain Setup](#custom-domain-setup)
8. [Caddy as Reverse Proxy](#caddy-as-reverse-proxy)
9. [Security Hardening](#security-hardening)
10. [Monitoring & Maintenance](#monitoring--maintenance)
11. [Updating the Backend](#updating-the-backend)
12. [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Requirement | Minimum |
|------------|---------|
| **OS** | Ubuntu 22.04+ (Debian-based) |
| **Python** | 3.10+ |
| **Docker** | 24.0+ with BuildKit plugin |
| **RAM** | 2 GB (4 GB recommended for concurrent deployments) |
| **Disk** | 20 GB+ (Docker images consume space) |
| **Access** | Root or sudo privileges |
| **Ports** | 80, 443, 8000, 10000-10100 |

---

## VPS Setup

### 1. Update system

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl wget unzip htop
```

### 2. Install Python

```bash
sudo apt install -y python3 python3-pip python3-venv
python3 --version  # Should be 3.10+
```

### 3. Install Docker

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Install BuildKit plugin (REQUIRED — legacy builder won't work)
sudo apt-get install -y docker-buildx-plugin

# Add current user to docker group (avoids sudo for docker commands)
sudo usermod -aG docker $USER

# Apply group change (or logout/login)
newgrp docker

# Verify installation
docker --version
docker buildx version
```

### 4. Clone the repository

```bash
sudo mkdir -p /opt/gitlaunchpad
sudo chown $USER:$USER /opt/gitlaunchpad
git clone https://github.com/your-user/your-repo.git /opt/gitlaunchpad
cd /opt/gitlaunchpad/backend
```

---

## Install Dependencies

### Using virtual environment (recommended)

```bash
cd /opt/gitlaunchpad/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### System-wide (alternative)

```bash
cd /opt/gitlaunchpad/backend
pip install -r requirements.txt
```

### Required packages (`requirements.txt`)

```
fastapi>=0.104.0
uvicorn[standard]>=0.24.0
pydantic>=2.5.0
docker>=7.0.0
websockets>=12.0
```

---

## Configuration

### Environment variables

The backend itself requires no environment variables for basic operation. However, the **edge functions** (running on Lovable Cloud) require secrets configured via the Lovable Cloud dashboard:

| Secret | Purpose |
|--------|---------|
| `LOVABLE_API_KEY` | AI model access for repo analysis and build fixing |
| `GITHUB_TOKEN` | GitHub API auth for higher rate limits and private repos |
| `SUPABASE_URL` | Auto-configured by Lovable Cloud |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-configured by Lovable Cloud |

### Port allocation

The backend allocates preview ports from a pool of `10000-10100`. Ensure these are open in your firewall.

### Docker resource limits

Each container is limited to:
- **Memory:** 512 MB
- **CPU:** 1.0 core

These can be adjusted in `deployer.py` (`CONTAINER_MEM_LIMIT`, `CONTAINER_CPU_LIMIT`).

---

## Run the Backend

### Quick test

```bash
cd /opt/gitlaunchpad/backend
source venv/bin/activate  # if using venv
python3 main.py
# Server starts on http://0.0.0.0:8000
```

### Verify endpoints

```bash
# Health check (returns 404 — no root route, that's expected)
curl http://localhost:8000/docs
# → FastAPI auto-generated Swagger UI

# Test deploy endpoint
curl -X POST http://localhost:8000/api/deploy \
  -H "Content-Type: application/json" \
  -d '{"repo_url":"https://github.com/expressjs/express"}'
# → {"deploy_id":"...","status":"cloning"}

# Check deployment status
curl http://localhost:8000/api/deploy/{deploy_id}

# Kill a deployment
curl -X DELETE http://localhost:8000/api/deploy/{deploy_id}
```

---

## Systemd Service

Create a service so the backend auto-starts on boot and restarts on crash.

### Create service file

```bash
sudo tee /etc/systemd/system/gitlaunchpad.service > /dev/null << 'EOF'
[Unit]
Description=Git Launchpad API
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/gitlaunchpad/backend
ExecStart=/opt/gitlaunchpad/backend/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 --workers 2
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

# Resource limits for the API process itself
LimitNOFILE=65536
MemoryMax=1G

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=gitlaunchpad

[Install]
WantedBy=multi-user.target
EOF
```

> **Note:** If you installed dependencies system-wide (no venv), change `ExecStart` to:
> ```
> ExecStart=/usr/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --workers 2
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
# Follow logs in real-time
sudo journalctl -u gitlaunchpad -f

# Last 100 lines
sudo journalctl -u gitlaunchpad --no-pager -n 100

# Logs since last hour
sudo journalctl -u gitlaunchpad --since "1 hour ago"
```

---

## Custom Domain Setup

### DNS Configuration

At your domain registrar, add an A record:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | `api` | `your-vps-ip` | 300 |

Example: `api.gitlaunchpad.dev → 157.245.109.239`

### Update frontend

After DNS propagates (5-30 minutes), update the frontend `.env`:

```env
VITE_API_BASE_URL="https://api.gitlaunchpad.dev"
```

Rebuild and redeploy the frontend.

### Verify DNS

```bash
dig api.yourdomain.com +short
# Should return your VPS IP
```

---

## Caddy as Reverse Proxy

Caddy sits in front of FastAPI, handling HTTPS termination, compression, and security headers.

### Install Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

### Caddyfile configurations

#### Option A: With custom domain (recommended — auto HTTPS)

```caddy
api.yourdomain.com {
    reverse_proxy localhost:8000

    header {
        Access-Control-Allow-Origin *
        Access-Control-Allow-Methods "GET, POST, DELETE, OPTIONS"
        Access-Control-Allow-Headers "Content-Type, Authorization"
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
    }

    encode gzip zstd
}
```

#### Option B: Without domain (self-signed TLS on bare IP)

```caddy
:443 {
    tls internal
    reverse_proxy localhost:8000

    header {
        Access-Control-Allow-Origin *
        Access-Control-Allow-Methods "GET, POST, DELETE, OPTIONS"
        Access-Control-Allow-Headers "Content-Type, Authorization"
    }

    encode gzip
}
```

> ⚠️ Browsers will show a security warning with self-signed certs. This works for development but is not recommended for production.

#### Option C: Frontend + Backend on same server

```caddy
yourdomain.com {
    root * /var/www/gitlaunchpad
    file_server
    try_files {path} /index.html
    encode gzip zstd

    header {
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
}

api.yourdomain.com {
    reverse_proxy localhost:8000

    header {
        Access-Control-Allow-Origin https://yourdomain.com
        Access-Control-Allow-Methods "GET, POST, DELETE, OPTIONS"
        Access-Control-Allow-Headers "Content-Type, Authorization"
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
    }

    encode gzip zstd
}
```

### Start Caddy

```bash
# Validate config
caddy validate --config /etc/caddy/Caddyfile

# Enable and start
sudo systemctl enable caddy
sudo systemctl restart caddy
sudo systemctl status caddy

# Check logs
sudo journalctl -u caddy -f
```

---

## Security Hardening

### 1. Firewall (UFW)

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80/tcp          # Caddy ACME challenge
sudo ufw allow 443/tcp         # HTTPS
sudo ufw allow 10000:10100/tcp # Container preview ports
sudo ufw enable
sudo ufw status numbered
```

### 2. Dedicated service user

```bash
# Create a non-root user
sudo useradd -m -s /bin/bash gitlaunchpad
sudo usermod -aG docker gitlaunchpad

# Transfer ownership
sudo chown -R gitlaunchpad:gitlaunchpad /opt/gitlaunchpad

# Update systemd service
sudo sed -i 's/User=root/User=gitlaunchpad/' /etc/systemd/system/gitlaunchpad.service
sudo systemctl daemon-reload
sudo systemctl restart gitlaunchpad
```

### 3. SSH hardening

```bash
# Disable root login and password auth
sudo sed -i 's/#PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd
```

> **Important:** Ensure you have SSH key access configured before disabling password auth.

### 4. Docker cleanup cron

Old Docker images and containers can fill disk. Add automatic cleanup:

```bash
# Add to crontab (runs daily at 3 AM)
(crontab -l 2>/dev/null; echo "0 3 * * * docker system prune -af --volumes --filter 'until=48h' >> /var/log/docker-cleanup.log 2>&1") | crontab -
```

### 5. Fail2Ban (optional)

```bash
sudo apt install -y fail2ban
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

---

## Monitoring & Maintenance

### Check system health

```bash
# API service status
sudo systemctl status gitlaunchpad

# Active containers
docker ps --format "table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}"

# Disk usage
df -h
docker system df

# Memory & CPU
htop
```

### Log rotation

Systemd journal auto-rotates, but you can configure limits:

```bash
sudo tee /etc/systemd/journald.conf.d/gitlaunchpad.conf > /dev/null << 'EOF'
[Journal]
SystemMaxUse=500M
MaxRetentionSec=30day
EOF
sudo systemctl restart systemd-journald
```

### Health check script

Create a simple monitoring script:

```bash
sudo tee /opt/gitlaunchpad/healthcheck.sh > /dev/null << 'SCRIPT'
#!/bin/bash
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/docs)
if [ "$HTTP_CODE" != "200" ]; then
    echo "$(date): API DOWN (HTTP $HTTP_CODE) — restarting..." >> /var/log/gitlaunchpad-health.log
    sudo systemctl restart gitlaunchpad
fi
SCRIPT
chmod +x /opt/gitlaunchpad/healthcheck.sh

# Run every 5 minutes
(crontab -l 2>/dev/null; echo "*/5 * * * * /opt/gitlaunchpad/healthcheck.sh") | crontab -
```

---

## Updating the Backend

```bash
cd /opt/gitlaunchpad

# Pull latest code
git pull origin main

# Update dependencies (if using venv)
cd backend
source venv/bin/activate
pip install -r requirements.txt

# Restart the service
sudo systemctl restart gitlaunchpad

# Verify
sudo systemctl status gitlaunchpad
sudo journalctl -u gitlaunchpad -f --since "1 minute ago"
```

### Zero-downtime update (advanced)

For zero-downtime, run two instances on different ports and use Caddy load balancing:

```caddy
api.yourdomain.com {
    reverse_proxy localhost:8000 localhost:8001 {
        lb_policy round_robin
        health_uri /docs
        health_interval 10s
    }
}
```

---

## Troubleshooting

### Backend won't start

```bash
# Check if port 8000 is in use
sudo lsof -i :8000

# Check service logs
sudo journalctl -u gitlaunchpad --no-pager -n 50

# Test manually
cd /opt/gitlaunchpad/backend
source venv/bin/activate
python3 main.py
# Look at the error output
```

### Docker build fails

```bash
# Verify BuildKit is installed
docker buildx version

# If missing:
sudo apt-get install -y docker-buildx-plugin

# Check Docker daemon
sudo systemctl status docker
docker info

# Check disk space (builds need space)
df -h
docker system df
docker system prune -af  # Clean up if needed
```

### Caddy won't start

```bash
# Validate Caddyfile syntax
caddy validate --config /etc/caddy/Caddyfile

# Check if port 80/443 is taken (by Nginx, Apache, etc.)
sudo lsof -i :80
sudo lsof -i :443

# Check logs
sudo journalctl -u caddy --no-pager -n 50
```

### Container previews not accessible

```bash
# List running containers
docker ps

# Check container logs
docker logs <container-id>

# Verify firewall allows preview ports
sudo ufw status | grep 10000

# Test port from inside the server
curl http://localhost:<preview-port>
```

### WebSocket connection issues

```bash
# Ensure Caddy proxies WebSocket upgrades (it does by default)
# Test WebSocket with wscat
npm install -g wscat
wscat -c wss://api.yourdomain.com/ws/logs/<deploy_id>
```

### SSL certificate issues

| Scenario | Solution |
|----------|----------|
| **With domain** | Caddy auto-handles it. Verify DNS A record → your IP, ports 80+443 open |
| **Without domain** | Use `tls internal` (self-signed). Browser warning is expected |
| **Cert renewal fails** | Check `sudo journalctl -u caddy`, ensure port 80 is reachable |

### Out of memory

```bash
# Check what's consuming memory
docker stats --no-stream

# Kill stuck containers
docker kill $(docker ps -q)

# Increase swap (temporary fix)
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```
