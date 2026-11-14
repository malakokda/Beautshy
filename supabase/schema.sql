CREATE TABLE public.price_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query text NOT NULL,
  mode text NOT NULL DEFAULT 'name',
  status text NOT NULL DEFAULT 'pending',
  error text,
  results jsonb,
  source text NOT NULL DEFAULT 'make',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_searches_status_check CHECK (status IN ('pending','done','failed')),
  CONSTRAINT price_searches_mode_check CHECK (mode IN ('name','url')),
  CONSTRAINT price_searches_source_check CHECK (source IN ('make','demo'))
);

GRANT SELECT, INSERT, UPDATE ON public.price_searches TO anon, authenticated;
GRANT ALL ON public.price_searches TO service_role;

ALTER TABLE public.price_searches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read search results"
  ON public.price_searches FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Anyone can start a pending search"
  ON public.price_searches FOR INSERT
  TO anon, authenticated
  WITH CHECK (status = 'pending');

CREATE POLICY "Pending searches can receive results"
  ON public.price_searches FOR UPDATE
  TO anon, authenticated
  USING (status = 'pending');

-- Stores added by pasting a link into the search box.
-- Only the server (service role) reads and writes this table.
CREATE TABLE IF NOT EXISTS public.added_stores (
  url text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.added_stores TO service_role;

ALTER TABLE public.added_stores ENABLE ROW LEVEL SECURITY;
