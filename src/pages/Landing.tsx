import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Zap, Shield, Clock, ArrowRight, Terminal, Sparkles, Code2, Database, Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Navbar from "@/components/Navbar";

const features = [
  {
    icon: Zap,
    title: "Instant Deploy",
    description: "Clone, build, and serve any public repo in under 60 seconds. Zero config required.",
  },
  {
    icon: Shield,
    title: "Sandboxed & Safe",
    description: "Every preview runs in an isolated Docker container. Your code never persists on our servers.",
  },
  {
    icon: Clock,
    title: "Auto-Expiring Previews",
    description: "Get a shareable live URL that auto-expires. Perfect for quick demos, code reviews, and PRs.",
  },
];

const supportedTech = [
  { name: "Node.js", icon: Code2 },
  { name: "Python", icon: Cpu },
  { name: "Elixir", icon: Database },
  { name: "Go", icon: Terminal },
];

const Landing = () => {
  const [repoUrl, setRepoUrl] = useState("");
  const navigate = useNavigate();

  const handleLaunch = () => {
    if (repoUrl.trim()) {
      navigate(`/deploy?repo=${encodeURIComponent(repoUrl.trim())}`);
    }
  };

  return (
    <div className="min-h-screen bg-background bg-grid-pattern">
      <Navbar />

      {/* Hero */}
      <main className="container mx-auto px-6 pt-32 pb-24">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: "easeOut" }}
          className="mx-auto max-w-3xl text-center"
        >
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-sm text-primary">
            <Sparkles className="h-3.5 w-3.5" />
            Now with AI-powered auto-fix
          </div>

          <h1 className="text-5xl font-extrabold leading-[1.1] tracking-tight sm:text-6xl lg:text-7xl">
            Deploy any GitHub repo{" "}
            <span className="text-primary text-glow">in 60 seconds</span>
          </h1>

          <p className="mt-6 text-lg text-muted-foreground sm:text-xl max-w-2xl mx-auto">
            Paste a link. Get a live URL. Auto-detects databases, installs dependencies, and fixes build errors with AI.
          </p>

          {/* Input */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.2 }}
            className="mt-10 flex flex-col sm:flex-row gap-3 max-w-xl mx-auto"
          >
            <div className="relative flex-1">
              <Terminal className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLaunch()}
                placeholder="https://github.com/user/repo"
                className="h-12 pl-10 bg-card border-border font-mono text-sm placeholder:text-muted-foreground/50 focus:border-primary focus:ring-primary/20"
                aria-label="GitHub repository URL"
              />
            </div>
            <Button
              onClick={handleLaunch}
              size="lg"
              className="h-12 px-8 gap-2 bg-primary text-primary-foreground hover:bg-primary/90 glow-cyan font-semibold"
            >
              Launch Preview
              <ArrowRight className="h-4 w-4" />
            </Button>
          </motion.div>

          <p className="mt-4 text-sm text-muted-foreground">
            No signup required to try. Auto-detects MongoDB, MySQL, Postgres, and Redis.
          </p>
        </motion.div>

        {/* Features */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.4 }}
          className="mx-auto mt-24 grid max-w-4xl gap-6 sm:grid-cols-3"
        >
          {features.map((feature, i) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.5 + i * 0.1 }}
              className="group rounded-xl border border-border bg-card/50 p-6 transition-all hover:border-primary/30 hover:bg-card"
            >
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-all group-hover:glow-cyan-sm">
                <feature.icon className="h-5 w-5" />
              </div>
              <h3 className="mb-2 font-semibold">{feature.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{feature.description}</p>
            </motion.div>
          ))}
        </motion.div>

        {/* How it works */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.7 }}
          className="mx-auto mt-24 max-w-3xl"
        >
          <h2 className="text-2xl font-bold text-center mb-10">How it works</h2>
          <div className="grid sm:grid-cols-3 gap-8">
            {[
              { step: "1", title: "Paste URL", desc: "Drop in any public GitHub repo URL" },
              { step: "2", title: "AI Analyzes", desc: "We detect language, framework, and services" },
              { step: "3", title: "Go Live", desc: "Get a shareable preview URL in seconds" },
            ].map((item, i) => (
              <motion.div
                key={item.step}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.8 + i * 0.1 }}
                className="text-center"
              >
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border-2 border-primary text-primary font-bold text-sm">
                  {item.step}
                </div>
                <h3 className="font-semibold mb-1">{item.title}</h3>
                <p className="text-sm text-muted-foreground">{item.desc}</p>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Supported tech */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.9 }}
          className="mt-20 text-center"
        >
          <p className="text-sm text-muted-foreground mb-4">Works with</p>
          <div className="flex items-center justify-center gap-6 flex-wrap">
            {supportedTech.map((tech) => (
              <div key={tech.name} className="flex items-center gap-2 text-muted-foreground/70">
                <tech.icon className="h-4 w-4" />
                <span className="text-sm font-mono">{tech.name}</span>
              </div>
            ))}
            <span className="text-sm text-muted-foreground/50">+ more</span>
          </div>
        </motion.div>

        {/* Bottom tagline */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.0 }}
          className="mt-20 text-center text-sm text-muted-foreground/60 font-mono"
        >
          Built for devs who hate setup.
        </motion.p>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/50 py-8">
        <div className="container mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-primary" />
            <span className="font-semibold text-foreground">GitPreview</span>
          </div>
          <p>© {new Date().getFullYear()} GitPreview. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
};

export default Landing;