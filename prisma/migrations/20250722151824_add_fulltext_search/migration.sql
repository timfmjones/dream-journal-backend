-- Enable full-text search
ALTER TABLE "Dream" 
ADD COLUMN IF NOT EXISTS "search_vector" tsvector 
GENERATED ALWAYS AS (
  setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE("dreamText", '')), 'B') ||
  setweight(to_tsvector('english', COALESCE(story, '')), 'C')
) STORED;

-- Create GIN index for full-text search
CREATE INDEX IF NOT EXISTS "Dream_search_idx" ON "Dream" USING GIN ("search_vector");

-- Create index for array searches
CREATE INDEX IF NOT EXISTS "Dream_tags_idx" ON "Dream" USING GIN ("tags");