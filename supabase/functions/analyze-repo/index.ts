import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const CONFIG_FILES = [
  "package.json", "requirements.txt", "Pipfile", "pyproject.toml",
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
  "Cargo.toml", "go.mod", "Makefile", "Procfile",
  ".env.example", ".env.sample", ".env.template",
  "tsconfig.json", "vite.config.ts", "vite.config.js",
  "next.config.js", "next.config.mjs", "nuxt.config.ts", "angular.json",
  "manage.py", "app.py", "main.py", "server.js", "server.ts",
  "index.js", "index.ts", "pom.xml", "build.gradle", "composer.json", "Gemfile",
];

const ENV_FILES = [".env.example", ".env.sample", ".env.template", ".env.development", ".env.local.example"];

// --- GitHub helpers ---

function getGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Lovable-Deploy",
  };
  const token = Deno.env.get("GITHUB_TOKEN");
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function fetchGitHubTree(owner: string, repo: string): Promise<string[]> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
    { headers: getGitHubHeaders() }
  );
  if (!res.ok) throw new Error(`GitHub tree API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.tree || []).filter((t: any) => t.type === "blob").map((t: any) => t.path as string);
}

async function fetchFileContent(owner: string, repo: string, path: string): Promise<string | null> {
  try {
    const rawHeaders = getGitHubHeaders();
    rawHeaders["Accept"] = "application/vnd.github.v3.raw";
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers: rawHeaders }
    );
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > 5000 ? text.slice(0, 5000) + "\n... (truncated)" : text;
  } catch { return null; }
}

function parseRepoUrl(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
  if (!match) throw new Error("Invalid GitHub URL");
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

// --- Env var parsing ---

interface ParsedEnvVar {
  key: string;
  default_value: string;
}

function extractEnvVarsFromContent(content: string): ParsedEnvVar[] {
  const vars: ParsedEnvVar[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    const value = trimmed.slice(eqIdx + 1).trim();
    vars.push({ key, default_value: value });
  }
  return vars;
}

// --- Platform services ---

interface PlatformService {
  service_type: string;
  display_name: string;
  connection_url: string | null;
  host: string | null;
  port: number | null;
  username: string | null;
  password: string | null;
  is_running: boolean;
  env_key_patterns: string[];
}

async function fetchPlatformServices(): Promise<PlatformService[]> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) return [];

    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data, error } = await supabase
      .from("platform_services")
      .select("*");
    
    if (error || !data) return [];
    return data as PlatformService[];
  } catch {
    return [];
  }
}

function matchEnvVarToService(envKey: string, services: PlatformService[]): PlatformService | null {
  for (const svc of services) {
    if (svc.env_key_patterns.some(pattern => envKey.toUpperCase() === pattern.toUpperCase())) {
      return svc;
    }
  }
  // Fuzzy match: check if key contains service type name
  const keyUpper = envKey.toUpperCase();
  for (const svc of services) {
    const typeUpper = svc.service_type.toUpperCase();
    if (keyUpper.includes(typeUpper) && (keyUpper.includes("URL") || keyUpper.includes("HOST") || keyUpper.includes("CONNECTION"))) {
      return svc;
    }
  }
  return null;
}

function buildConnectionUrl(svc: PlatformService): string {
  if (svc.connection_url) return svc.connection_url;
  const proto = svc.service_type === "redis" ? "redis" : svc.service_type === "mongodb" ? "mongodb" : svc.service_type;
  const auth = svc.username ? `${svc.username}${svc.password ? `:${svc.password}` : ""}@` : "";
  return `${proto}://${auth}${svc.host || "host.docker.internal"}:${svc.port}/${svc.service_type}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { repo_url } = await req.json();
    if (!repo_url) throw new Error("repo_url is required");

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const { owner, repo } = parseRepoUrl(repo_url);

    // Fetch platform services and GitHub data in parallel
    const [allFiles, platformServices] = await Promise.all([
      fetchGitHubTree(owner, repo),
      fetchPlatformServices(),
    ]);

    // Fetch config files
    const configFilesToFetch = allFiles.filter((f) => {
      const basename = f.split("/").pop() || "";
      return CONFIG_FILES.includes(basename) || CONFIG_FILES.includes(f);
    }).slice(0, 15);

    const envFilesToFetch = allFiles.filter((f) => {
      const basename = f.split("/").pop() || "";
      return ENV_FILES.includes(basename);
    }).slice(0, 5);

    const allFilesToFetch = [...new Set([...configFilesToFetch, ...envFilesToFetch])];

    const fileContents: Record<string, string> = {};
    await Promise.all(
      allFilesToFetch.map(async (path) => {
        const content = await fetchFileContent(owner, repo, path);
        if (content) fileContents[path] = content;
      })
    );

    // Extract env vars from .env.example files ONLY
    const parsedEnvVars: ParsedEnvVar[] = [];
    for (const [path, content] of Object.entries(fileContents)) {
      const basename = path.split("/").pop() || "";
      if (ENV_FILES.includes(basename)) {
        parsedEnvVars.push(...extractEnvVarsFromContent(content));
      }
    }
    const uniqueEnvVars = parsedEnvVars.filter(
      (v, i, arr) => arr.findIndex((x) => x.key === v.key) === i
    );

    // Build AI prompt
    const treeStr = allFiles.slice(0, 200).join("\n");
    const configStr = Object.entries(fileContents)
      .map(([path, content]) => `--- ${path} ---\n${content}`)
      .join("\n\n");

    const envVarsList = uniqueEnvVars.map(v =>
      `${v.key}=${v.default_value}`
    ).join("\n");

    const systemPrompt = `You are a deployment configuration expert. Given a GitHub repository's file tree and config files, analyze the project and return a JSON deployment configuration.

You MUST respond with ONLY valid JSON (no markdown, no explanation) in this exact format:
{
  "language": "string",
  "framework": "string",
  "install_cmd": "string",
  "build_cmd": "string",
  "start_cmd": "string",
  "port": number,
  "dockerfile_content": "string (a complete Dockerfile)",
  "env_vars": [
    {
      "key": "VAR_NAME",
      "value": "suggested_value_or_empty",
      "needs_user_input": true/false,
      "description": "short explanation"
    }
  ]
}

CRITICAL RULES for env_vars:
- ONLY include variables that exist in the .env.example file provided below. Do NOT invent new variables.
- For each variable, decide:
  - If it has a sensible default value (like a port number, boolean flag, localhost URL, deployment mode), set "value" to that default and "needs_user_input" to false.
  - If it's a database URL pointing to localhost, generate a working Docker-compatible value (use host.docker.internal instead of localhost) and set "needs_user_input" to false.
  - If it's a SECRET, API KEY, or external service credential (like OPENAI_API_KEY, STRIPE_KEY, etc.), set "value" to "" and "needs_user_input" to true.
  - If the .env.example already has a value, use that value and set "needs_user_input" to false.

Rules for the Dockerfile:
- Use multi-stage builds when appropriate
- Always EXPOSE the correct port
- Use slim/alpine base images when possible
- Set proper WORKDIR
- Copy dependency files first for better layer caching
- The CMD should match start_cmd
- Include all necessary system dependencies`;

    const userPrompt = `Analyze this repository and provide deployment configuration.

Repository: ${owner}/${repo}

File tree (top 200 files):
${treeStr}

Config file contents:
${configStr}

${uniqueEnvVars.length > 0 ? `\nEnvironment variables from .env.example (ONLY use these, do not add others):\n${envVarsList}` : "\nNo .env.example file found. Set env_vars to an empty array."}`;

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
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again later." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Please add funds." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errText = await aiResponse.text();
      console.error("AI gateway error:", aiResponse.status, errText);
      throw new Error(`AI analysis failed: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    const rawContent = aiData.choices?.[0]?.message?.content || "";

    let deployConfig;
    try {
      const cleaned = rawContent.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      deployConfig = JSON.parse(cleaned);
    } catch {
      console.error("Failed to parse AI response:", rawContent);
      throw new Error("AI returned invalid deployment config");
    }

    // Use AI-generated env_vars
    let envVarsResult = deployConfig.env_vars || [];
    if (!Array.isArray(envVarsResult) || envVarsResult.length === 0) {
      envVarsResult = uniqueEnvVars.map(v => ({
        key: v.key,
        value: v.default_value,
        needs_user_input: false,
        description: "",
      }));
    }

    // Safety: filter out hallucinated vars
    if (uniqueEnvVars.length > 0) {
      const allowedKeys = new Set(uniqueEnvVars.map(v => v.key));
      envVarsResult = envVarsResult.filter((v: any) => allowedKeys.has(v.key));
    }

    // --- Match env vars to platform services ---
    const platformMatches: Record<string, { service: PlatformService; connection_url: string }> = {};
    
    for (const envVar of envVarsResult) {
      const matchedService = matchEnvVarToService(envVar.key, platformServices);
      if (matchedService) {
        const connUrl = buildConnectionUrl(matchedService);
        platformMatches[envVar.key] = {
          service: matchedService,
          connection_url: connUrl,
        };
        
        // Auto-fill if service is running
        if (matchedService.is_running) {
          envVar.value = connUrl;
          envVar.needs_user_input = false;
          envVar.platform_provided = true;
          envVar.platform_service = matchedService.service_type;
          envVar.platform_display_name = matchedService.display_name;
          envVar.platform_running = true;
        } else {
          // Service not running - flag it
          envVar.platform_provided = false;
          envVar.platform_service = matchedService.service_type;
          envVar.platform_display_name = matchedService.display_name;
          envVar.platform_running = false;
          envVar.needs_user_input = true;
        }
      }
    }

    // Fetch repo metadata
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: getGitHubHeaders(),
    });
    let repoMeta = {};
    if (repoRes.ok) {
      const r = await repoRes.json();
      repoMeta = {
        name: r.name, fullName: r.full_name,
        description: r.description || "",
        language: r.language || deployConfig.language,
        stars: r.stargazers_count, defaultBranch: r.default_branch,
      };
    }

    const detectedStack = [deployConfig.language, deployConfig.framework].filter(Boolean);

    // Build platform services summary for frontend
    const platformServicesSummary = platformServices.map(s => ({
      service_type: s.service_type,
      display_name: s.display_name,
      is_running: s.is_running,
    }));

    // --- Detect companion service dependencies from env var keys ---
    const serviceDetectPatterns: Record<string, string[]> = {
      mysql: ["MYSQL", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME", "MYSQL_URL"],
      postgres: ["POSTGRES", "DATABASE_URL", "PG_", "PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"],
      redis: ["REDIS_URL", "REDIS_HOST", "REDIS_PORT"],
      mongodb: ["MONGODB_URI", "MONGO_URL", "MONGO_URI", "MONGODB_URL"],
    };

    const detectedServices: string[] = [];
    const envKeySet = envVarsResult.map((v: any) => v.key.toUpperCase());
    for (const [service, patterns] of Object.entries(serviceDetectPatterns)) {
      for (const key of envKeySet) {
        if (patterns.some(p => key.includes(p))) {
          if (!detectedServices.includes(service)) {
            detectedServices.push(service);
          }
          break;
        }
      }
    }

    return new Response(
      JSON.stringify({
        repo: repoMeta,
        deploy_config: {
          language: deployConfig.language,
          framework: deployConfig.framework,
          install_cmd: deployConfig.install_cmd,
          build_cmd: deployConfig.build_cmd,
          start_cmd: deployConfig.start_cmd,
          port: deployConfig.port,
          dockerfile_content: deployConfig.dockerfile_content,
          detected_services: detectedServices,
        },
        detected_stack: detectedStack,
        detected_services: detectedServices,
        files_analyzed: Object.keys(fileContents),
        env_vars: envVarsResult,
        required_env_vars: envVarsResult.map((v: any) => v.key),
        platform_services: platformServicesSummary,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("analyze-repo error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
