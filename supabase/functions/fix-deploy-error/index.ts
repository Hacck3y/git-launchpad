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
    } = await req.json();

    if (!error_log) throw new Error("error_log is required");

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

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
- Need to set HOST=0.0.0.0 for web servers to bind correctly in Docker

Rules:
- Always use slim/alpine base images
- Always EXPOSE the correct port
- Always set WORKDIR /app
- If the app needs a .env file, include COPY .env .env
- Make the Dockerfile self-contained and robust
- Add error handling where possible`;

    const userPrompt = `Deployment failed (attempt ${attempt || 1}). Please fix it.

ERROR LOG:
${error_log}

CURRENT DOCKERFILE:
${dockerfile_content || "Not provided"}

DETECTED LANGUAGE: ${language || "unknown"}
DETECTED FRAMEWORK: ${framework || "unknown"}
CURRENT START CMD: ${start_cmd || "unknown"}
CURRENT PORT: ${port || 3000}

REPO FILES (partial list):
${(repo_files || []).slice(0, 100).join("\n")}`;

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
