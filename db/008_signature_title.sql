-- =============================================================================
-- 008 · Signature laid out like Vic's; "Executive Assistant to …" instead of "Scheduling
-- Assistant to …"
--
-- Idempotent (run after 001–007; running it twice is a no-op). Only rewrites
-- titles that still have the old default wording, so a custom title is kept.
-- New sign-ins get the new wording from portal_sign_in: re-run 004_portal.sql
-- (also idempotent) to pick up that function change.
-- =============================================================================
SET search_path = sched, public;
SET client_min_messages = warning;

UPDATE employees
   SET signature_title = 'Executive Assistant to ' || substr(signature_title, length('Scheduling Assistant to ') + 1)
 WHERE signature_title LIKE 'Scheduling Assistant to %';

UPDATE settings
   SET value = to_jsonb('Executive Assistant to ' || substr(value #>> '{}', length('Scheduling Assistant to ') + 1))
 WHERE key = 'signature_title'
   AND value #>> '{}' LIKE 'Scheduling Assistant to %';

-- Signature laid out like Vic's: name, title, company, phone, email, website.
-- The "Email:" line is sarah_upn. Existing values are kept (ON CONFLICT DO NOTHING).
UPDATE settings SET value = '"BluZoneBio"' WHERE key = 'company_name' AND value #>> '{}' = 'Blu Zone Bio';
INSERT INTO settings (key, value, note) VALUES
  ('signature_phone',   '""',                   'Phone line of the signature (fourth line). Empty = no phone line.'),
  ('signature_website', '"www.bluzonebio.com"', 'Last line of the signature ("Website: …"). Empty = no website line. The "Email:" line is sarah_upn.')
ON CONFLICT (key) DO NOTHING;
