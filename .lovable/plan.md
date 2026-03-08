

## AI-Powered Deployment Intelligence

### Problem
Simple repos (e.g., Node.js with `npm start`) deploy easily, but complex repos need intelligence to figure out: what language/framework, what commands to install dependencies, how to build, and how to run.

### Recommended Approach: Lovable AI (Built-in, No API Key Needed)

Your project already has access to **Lovable AI** with models like `google/gemini-2.5-flash` — fast, cheap, and good at code analysis. No external API key required.

**Why not OpenRouter/OpenClaw?**
- Requires managing an external API key
- Extra cost and setup
- Lovable AI covers this use case perfectly

### Architecture

```text
Frontend (Deploy page)
   │
   ▼
Edge Function: analyze-repo
   │  ← Calls Lovable AI (gemini-2.5-flash)
   │  ← Input: repo URL, file listing, key config files
   │  ← Output: JSON with install/build/run commands, port, Dockerfile
   ▼
Backend VPS (main.py → deployer.py)
   │  ← Receives AI-generated deploy instructions
   ▼
Docker container runs the app
```

### How It Works

1. **Frontend** sends repo URL to a new **edge function** (`analyze-repo`)
2. Edge function fetches the repo's file tree + key files (`package.json`, `requirements.txt`, `Dockerfile`, `docker-compose.yml`, etc.) via GitHub API
3. Sends a prompt to Lovable AI: *"Given this repo structure and config files, return JSON with: language, framework, install_command, build_command, start_command, port, and a Dockerfile if none exists"*
4. Returns structured JSON to frontend
5. Frontend passes these AI-generated instructions to your VPS backend (`main.py`)
6. `deployer.py` uses the AI-provided Dockerfile/commands instead of hardcoded logic

### Implementation Steps

1. **Create edge function `analyze-repo`** — accepts repo URL, fetches repo metadata from GitHub, calls Lovable AI for build instructions, returns structured deployment config
2. **Update `Deploy.tsx`** — after repo URL validation, call the edge function to get AI-analyzed build instructions before sending to the VPS backend
3. **Update `src/lib/api.ts`** — include the AI-generated deploy config in the deploy request payload
4. **VPS backend changes** (deployer.py) — accept and use the AI-provided Dockerfile/commands instead of guessing

### AI Prompt Strategy

The AI prompt would include:
- File tree listing
- Contents of detected config files (package.json, requirements.txt, Dockerfile, etc.)
- Request for JSON output: `{ language, framework, install_cmd, build_cmd, start_cmd, port, dockerfile_content }`

This handles complex repos (monorepos, custom frameworks, multi-stage builds) because the AI reasons about the specific repo rather than following rigid rules.

### Cost & Speed
- `gemini-2.5-flash` is fast (~1-2s) and cheap
- One AI call per deployment
- No external API key management

