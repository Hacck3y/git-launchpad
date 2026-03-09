import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Terminal, LogOut, Settings, Menu, X, LayoutDashboard, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/contexts/AuthContext";

const Navbar = () => {
  const location = useLocation();
  const isLanding = location.pathname === "/";
  const { user, profile, loading, signInWithGoogle, signOut } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
      <div className="container mx-auto flex h-16 items-center justify-between px-6">
        <Link to="/" className="flex items-center gap-2.5 group">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 border border-primary/20 group-hover:glow-cyan-sm transition-all">
            <Terminal className="h-4 w-4 text-primary" />
          </div>
          <span className="text-lg font-bold tracking-tight">
            Git<span className="text-primary">Preview</span>
          </span>
        </Link>

        {/* Desktop nav */}
        <div className="hidden sm:flex items-center gap-2">
          {!isLanding && user && (
            <>
              <Link to="/dashboard">
                <Button
                  variant="ghost"
                  size="sm"
                  className={`gap-1.5 text-sm ${location.pathname === "/dashboard" ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <LayoutDashboard className="h-3.5 w-3.5" />
                  Dashboard
                </Button>
              </Link>
              <Link to="/deploy">
                <Button
                  variant="ghost"
                  size="sm"
                  className={`gap-1.5 text-sm ${location.pathname === "/deploy" ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <Rocket className="h-3.5 w-3.5" />
                  Deploy
                </Button>
              </Link>
            </>
          )}

          {loading ? null : user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-2 px-2 ml-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary border border-primary/20">
                    {(profile?.display_name || profile?.email || "U").charAt(0).toUpperCase()}
                  </div>
                  <span className="text-sm max-w-[120px] truncate hidden md:inline">
                    {profile?.display_name || profile?.email || "User"}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <div className="px-2 py-1.5">
                  <p className="text-sm font-medium truncate">{profile?.display_name || "User"}</p>
                  <p className="text-xs text-muted-foreground truncate">{profile?.email || user.email}</p>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild className="gap-2 cursor-pointer">
                  <Link to="/settings">
                    <Settings className="h-4 w-4" />
                    Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={signOut} className="gap-2 cursor-pointer text-destructive focus:text-destructive">
                  <LogOut className="h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button
              onClick={signInWithGoogle}
              variant="outline"
              size="sm"
              className="gap-2 border-border hover:border-primary/50 hover:bg-primary/5"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              Sign in with Google
            </Button>
          )}
        </div>

        {/* Mobile hamburger */}
        <div className="sm:hidden">
          <Button variant="ghost" size="sm" onClick={() => setMobileOpen(!mobileOpen)}>
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="sm:hidden border-t border-border/50 bg-background/95 backdrop-blur-xl px-6 py-4 space-y-2">
          {user && (
            <>
              <Link to="/dashboard" onClick={() => setMobileOpen(false)}>
                <Button variant="ghost" size="sm" className="w-full justify-start gap-2">
                  <LayoutDashboard className="h-4 w-4" /> Dashboard
                </Button>
              </Link>
              <Link to="/deploy" onClick={() => setMobileOpen(false)}>
                <Button variant="ghost" size="sm" className="w-full justify-start gap-2">
                  <Rocket className="h-4 w-4" /> Deploy
                </Button>
              </Link>
              <Link to="/settings" onClick={() => setMobileOpen(false)}>
                <Button variant="ghost" size="sm" className="w-full justify-start gap-2">
                  <Settings className="h-4 w-4" /> Settings
                </Button>
              </Link>
              <Button variant="ghost" size="sm" onClick={signOut} className="w-full justify-start gap-2 text-destructive">
                <LogOut className="h-4 w-4" /> Sign out
              </Button>
            </>
          )}
          {!loading && !user && (
            <Button onClick={signInWithGoogle} variant="outline" size="sm" className="w-full gap-2">
              Sign in with Google
            </Button>
          )}
        </div>
      )}
    </nav>
  );
};

export default Navbar;