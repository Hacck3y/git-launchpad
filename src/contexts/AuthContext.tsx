import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface AuthContextType {
  session: Session | null;
  user: User | null;
  profile: { display_name: string | null; avatar_url: string | null; email: string | null } | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AuthContextType["profile"]>(null);
  const [loading, setLoading] = useState(true);

  const fetchProfile = async (userId: string) => {
    try {
      const { data } = await supabase
        .from("profiles")
        .select("display_name, avatar_url, email")
        .eq("user_id", userId)
        .single();
      setProfile(data);
    } catch {
      // Profile may not exist yet
    }
  };

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setSession(session);
        setUser(session?.user ?? null);
        if (session?.user) {
          setTimeout(() => fetchProfile(session.user.id), 0);
        } else {
          setProfile(null);
        }
        setLoading(false);
      }
    );

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        fetchProfile(session.user.id);
      }
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    try {
      const { lovable } = await import("@/integrations/lovable");
      await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin,
      });
    } catch (err) {
      console.error("Google sign-in failed:", err);
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setUser(null);
    setProfile(null);
  };

  return (
    <AuthContext.Provider value={{ session, user, profile, loading, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

const defaultAuthContext: AuthContextType = {
  session: null,
  user: null,
  profile: null,
  loading: false,
  signInWithGoogle: async () => {},
  signOut: async () => {},
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  return context ?? defaultAuthContext;
};
