import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Zap, Shield, Clock, ArrowRight, Github, Terminal, Sparkles } from "lucide-react";
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
    description: "Every preview runs in an isolated container. Your code never touches our servers permanently.",
  },
  {
    icon: Clock,
    title: "15 Min Live Preview",
    description: "Get a shareable live URL that stays active for 15 minutes. Perfect for quick demos and reviews.",
  },
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
            Now in public beta
          </div>

          <h1 className="text-5xl font-extrabold leading-[1.1] tracking-tight sm:text-6xl lg:text-7xl">
            Deploy any GitHub repo{" "}
            <span className="text-primary text-glow">in 60 seconds</span>
          </h1>

          <p className="mt-6 text-lg text-muted-foreground sm:text-xl max-w-2xl mx-auto">
            Paste a link. Get a live URL. Test for 15 minutes. No setup needed.
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
            First 5 deploys free. No credit card.
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

        {/* Bottom tagline */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8 }}
          className="mt-20 text-center text-sm text-muted-foreground/60 font-mono"
        >
          Built for devs who hate setup.
        </motion.p>
      </main>
    </div>
  );
};

export default Landing;
