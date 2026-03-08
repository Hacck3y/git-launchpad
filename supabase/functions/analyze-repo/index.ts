import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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

async function fetchGitHubTree(owner: string, repo: string): Promise<string[]> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
    { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "Lovable-Deploy" } }
  );
  if (!res.ok) throw new Error(`GitHub tree API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.tree || []).filter((t: any) => t.type === "blob").map((t: any) => t.path as string);
}

async function fetchFileContent(owner: string, repo: string, path: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers: { Accept: "application/vnd.github.v3.raw", "User-Agent": "Lovable-Deploy" } }
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

function extractEnvVarsFromContent(content: string): string[] {
  const vars: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=/);
    if (match) vars.push(match[1]);
  }
  return vars;
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
    const allFiles = await fetchGitHubTree(owner, repo);

    // Fetch config files
    const configFilesToFetch = allFiles.filter((f) => {
      const basename = f.split("/").pop() || "";
      return CONFIG_FILES.includes(basename) || CONFIG_FILES.includes(f);
    }).slice(0, 15);

    // Also find env example files
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

    // Extract env vars from env example files
    const detectedEnvVars: string[] = [];
    for (const [path, content] of Object.entries(fileContents)) {
      const basename = path.split("/").pop() || "";
      if (ENV_FILES.includes(basename)) {
        detectedEnvVars.push(...extractEnvVarsFromContent(content));
      }
    }
    const uniqueEnvVars = [...new Set(detectedEnvVars)];

    // Build AI prompt
    const treeStr = allFiles.slice(0, 200).join("\n");
    const configStr = Object.entries(fileContents)
      .map(([path, content]) => `--- ${path} ---\n${content}`)
      .join("\n\n");

    const systemPrompt = `You are a deployment configuration expert. Given a GitHub repository's file tree and config files, analyze the project and return a JSON deployment configuration.

You MUST respond with ONLY valid JSON (no markdown, no explanation) in this exact format:
{
  "language": "string (e.g. JavaScript, Python, Go, Rust, Java, etc.)",
  "framework": "string (e.g. React, Next.js, Django, Flask, Express, FastAPI, etc.)",
  "install_cmd": "string (command to install dependencies)",
  "build_cmd": "string (command to build the project, empty string if none needed)",
  "start_cmd": "string (command to start the application)",
  "port": number (the port the app listens on),
  "dockerfile_content": "string (a complete Dockerfile to build and run this project)",
  "required_env_vars": ["array of env var names that MUST be set for the app to work (e.g. API keys, database URLs, secrets). Include vars from .env.example files and any referenced in code. Do NOT include optional or cosmetic vars."]
}

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

${uniqueEnvVars.length > 0 ? `\nDetected env vars from .env.example files: ${uniqueEnvVars.join(", ")}` : ""}`;

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

    // Merge env vars: AI-detected + file-detected
    const aiEnvVars: string[] = deployConfig.required_env_vars || [];
    const allEnvVars = [...new Set([...uniqueEnvVars, ...aiEnvVars])];

    // Fetch repo metadata
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "Lovable-Deploy" },
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

    return new Response(
      JSON.stringify({
        repo: repoMeta,
        deploy_config: deployConfig,
        detected_stack: detectedStack,
        files_analyzed: Object.keys(fileContents),
        required_env_vars: allEnvVars,
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
