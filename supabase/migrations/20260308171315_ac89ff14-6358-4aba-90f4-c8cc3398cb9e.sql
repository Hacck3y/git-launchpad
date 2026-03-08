
CREATE TABLE public.platform_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_type TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  connection_url TEXT,
  host TEXT,
  port INTEGER,
  username TEXT,
  password TEXT,
  is_running BOOLEAN NOT NULL DEFAULT false,
  env_key_patterns TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read platform services"
ON public.platform_services FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can manage platform services"
ON public.platform_services FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TRIGGER update_platform_services_updated_at
  BEFORE UPDATE ON public.platform_services
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Pre-populate with Postgres (running on the VPS)
INSERT INTO public.platform_services (service_type, display_name, connection_url, host, port, username, password, is_running, env_key_patterns)
VALUES (
  'postgres',
  'PostgreSQL',
  'postgres://paperclip:paperclip@host.docker.internal:5432/paperclip',
  'host.docker.internal',
  5432,
  'paperclip',
  'paperclip',
  true,
  ARRAY['DATABASE_URL', 'POSTGRES_URL', 'PG_CONNECTION_STRING', 'DB_URL', 'PGURL']
);

INSERT INTO public.platform_services (service_type, display_name, host, port, is_running, env_key_patterns)
VALUES 
  ('mysql', 'MySQL', 'host.docker.internal', 3306, false, ARRAY['MYSQL_URL', 'MYSQL_CONNECTION_STRING', 'MYSQL_DATABASE_URL']),
  ('redis', 'Redis', 'host.docker.internal', 6379, false, ARRAY['REDIS_URL', 'REDIS_CONNECTION_STRING', 'REDIS_HOST']),
  ('mongodb', 'MongoDB', 'host.docker.internal', 27017, false, ARRAY['MONGODB_URL', 'MONGO_URL', 'MONGODB_URI', 'MONGO_URI']);
