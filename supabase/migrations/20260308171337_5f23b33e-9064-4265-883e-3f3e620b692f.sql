
DROP POLICY "Authenticated users can manage platform services" ON public.platform_services;

CREATE POLICY "Authenticated users can insert platform services"
ON public.platform_services FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update platform services"
ON public.platform_services FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can delete platform services"
ON public.platform_services FOR DELETE TO authenticated USING (true);
