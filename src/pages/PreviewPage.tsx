import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ExternalLink, Clock, AlertTriangle, Rocket, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import Navbar from "@/components/Navbar";

const PreviewPage = () => {
  const { id } = useParams();
  const [expired] = useState(false);
  const [countdown, setCountdown] = useState(732); // ~12 min simulated

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown((prev) => (prev <= 0 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="min-h-screen bg-background bg-grid-pattern">
      <Navbar />

      <main className="container mx-auto px-6 pt-32 pb-16 max-w-lg">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center"
        >
          {expired ? (
            <>
              <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-muted border border-border">
                <AlertTriangle className="h-8 w-8 text-muted-foreground" />
              </div>
              <h1 className="text-2xl font-bold mb-2">This preview has expired</h1>
              <p className="text-muted-foreground mb-8">The 15-minute window has ended. Want to spin it up again?</p>
              <Link to="/deploy">
                <Button className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
                  <Rocket className="h-4 w-4" />
                  Redeploy this repo
                </Button>
              </Link>
            </>
          ) : (
            <>
              <div className="rounded-xl border border-border bg-card/80 p-6 text-left mb-6">
                <h2 className="font-mono font-semibold text-lg mb-1">vercel/next.js</h2>
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
                  <User className="h-3.5 w-3.5" />
                  Deployed by @devuser
                </div>
                <div className={`flex items-center gap-2 text-sm ${countdown <= 120 ? "text-warning" : "text-muted-foreground"}`}>
                  <Clock className="h-3.5 w-3.5" />
                  Expires in: <span className="font-mono font-bold">{formatTime(countdown)}</span>
                </div>
              </div>

              <Button
                onClick={() => window.open("https://preview-k8x2m.gitpreview.dev", "_blank")}
                size="lg"
                className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 glow-cyan w-full"
              >
                <ExternalLink className="h-5 w-5" />
                Open App
              </Button>

              <p className="mt-4 text-xs text-muted-foreground">
                Preview ID: {id || "k8x2m"}
              </p>
            </>
          )}
        </motion.div>
      </main>
    </div>
  );
};

export default PreviewPage;
