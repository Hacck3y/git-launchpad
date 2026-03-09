import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const {
      error_log,
      dockerfile_content,
      repo_files,
      language,
      framework,
      start_cmd,
      port,
      attempt,
      package_manager,
      is_monorepo,
    } = await req.json();

    if (!error_log) throw new Error("error_log is required");

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const monorepoGuidance = is_monorepo ? `
CRITICAL MONOREPO RULES:
- This is a monorepo with workspace dependencies (workspace:* protocol)
- You MUST copy ALL source files before running install (COPY . .)
- NEVER copy only package.json files — workspace links will fail
- Use --no-frozen-lockfile flag for pnpm/yarn installs
- For pnpm: use "corepack enable && corepack prepare pnpm@latest --activate"
- Install native build tools: python3, make, g++, git
- The container uses --network host, so services on the host (postgres, redis, mysql) are accessible via localhost:<port>
` : "";

    const pkgManagerGuidance = package_manager === "pnpm" ? `
PNPM-SPECIFIC RULES:
- Use node:20-slim (NOT alpine — native modules need glibc)
- Enable corepack: RUN corepack enable && corepack prepare pnpm@latest --activate
- Always use: pnpm install --no-frozen-lockfile
- Install build tools: apt-get install -y python3 make g++ git
` : package_manager === "yarn" ? `
YARN-SPECIFIC RULES:
- Use yarn install --network-timeout 600000
- For yarn workspaces, copy all files before install
` : "";

    const systemPrompt = `You are a Docker deployment debugging expert. A deployment has failed. Your job is to analyze the error log and provide a FIXED Dockerfile and any additional commands needed.

You MUST respond with ONLY valid JSON (no markdown, no explanation) in this exact format:
{
  "diagnosis": "string (brief explanation of what went wrong)",
  "fixed_dockerfile": "string (the complete corrected Dockerfile)",
  "pre_build_commands": ["array of shell commands to run in the repo before docker build, e.g. creating files, fixing permissions"],
  "env_file_additions": {"KEY": "default_value_or_empty_string"},
  "port": number,
  "start_cmd": "string (corrected start command if needed)",
  "confidence": "high|medium|low"
}

NETWORKING: The container runs with --network host. Services on the host machine (PostgreSQL, MySQL, Redis, MongoDB) are accessible via localhost:<their_port>. Database URLs should use localhost, NOT host.docker.internal.

Common fixes you should know:
- Missing system dependencies (apt-get install, apk add)
- Wrong Node.js version (use appropriate version)
- Missing build tools (python3, make, gcc, g++ for native modules)
- Wrong start command or entry point
- Missing .env vars causing crashes
- Port mismatches
- Permission issues
- Missing Procfile or wrong process type
- Python: missing pip packages, wrong python version
- Node: missing node-gyp deps, wrong npm scripts
- Need to set HOST=0.0.0.0 for web servers to bind correctly
- For monorepos: COPY entire source before install, never just package.json

ELIXIR/PHOENIX-SPECIFIC FIXES:
- "erl_interface.h: No such file or directory" → Install erlang-dev: apt-get install -y erlang-dev
- Use full Debian-based Elixir images (e.g. elixir:1.14-otp-25), NOT alpine
- bcrypt/comeonin NIFs require: build-essential, erlang-dev, libssl-dev
- NEVER modify .exs config files — they use Elixir syntax (atoms, keywords), not key=value format
- For old Elixir apps (< 1.12), ensure compatible OTP version
- Run: mix local.hex --force && mix local.rebar --force before deps.get
- Default Phoenix port is 4000
- Start with: mix phx.server or MIX_ENV=prod mix phx.server
${monorepoGuidance}
${pkgManagerGuidance}

Rules:
- Use slim base images (node:20-slim for Node, NOT alpine for projects with native modules)
- For Elixir: use full Debian-based images (elixir:X.Y-otp-Z), NEVER alpine
- Always EXPOSE the correct port
- Always set WORKDIR /app
- If the app needs a .env file, include COPY .env .env
- Make the Dockerfile self-contained and robust
- Add error handling where possible
- For monorepos: ALWAYS do COPY . . BEFORE running install`;

    const userPrompt = `Deployment failed (attempt ${attempt || 1}). Please fix it.

PACKAGE MANAGER: ${package_manager || "npm"}
IS MONOREPO: ${is_monorepo ? "YES — uses workspace:* dependencies" : "no"}

ERROR LOG:
${error_log}

CURRENT DOCKERFILE:
${dockerfile_content || "Not provided"}

DETECTED LANGUAGE: ${language || "unknown"}
DETECTED FRAMEWORK: ${framework || "unknown"}
CURRENT START CMD: ${start_cmd || "unknown"}
CURRENT PORT: ${port || 3000}

REPO FILES (partial list):
${(repo_files || []).slice(0, 150).join("\n")}`;

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!aiResponse.ok) {
      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted" }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errText = await aiResponse.text();
      console.error("AI gateway error:", aiResponse.status, errText);
      throw new Error(`AI fix analysis failed: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    const rawContent = aiData.choices?.[0]?.message?.content || "";

    let fixConfig;
    try {
      const cleaned = rawContent.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      fixConfig = JSON.parse(cleaned);
    } catch {
      console.error("Failed to parse AI fix response:", rawContent);
      throw new Error("AI returned invalid fix config");
    }

    return new Response(JSON.stringify(fixConfig), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("fix-deploy-error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
