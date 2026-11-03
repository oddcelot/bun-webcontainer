-- Feedback from the playground's Feedback dialog and the docs' page rating (worker/index.ts, POST /api/feedback).
-- Only what the sender wrote or ticked; no IP address. Rows are deleted once dealt with (docs: /privacy/#feedback).
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY,
  -- "YYYY-MM-DDTHH:MM:SSZ"
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'rating')),
  -- Origin, path and query of the page it came from (never the #hash, which may hold a whole project).
  page TEXT NOT NULL DEFAULT '',
  rating TEXT CHECK (rating IN ('up', 'down')),
  message TEXT,
  email TEXT,
  -- JSON object: Bun release, browser and the like, when the sender ticked "include".
  env TEXT,
  -- A short link path (/s/<id>), when the sender attached the project.
  project TEXT
);
CREATE INDEX feedback_at ON feedback (at);
CREATE INDEX feedback_page ON feedback (page, rating);
