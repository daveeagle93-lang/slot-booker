-- Lanes and places: the layout of an event, and the final shape of the bookings table.
--
-- A lane is a ring that runs in parallel with the others; a place is one of an event's `capacity` bookings at one
-- time in one lane. Every event so far has exactly one unnamed lane with capacity 1, which is what this migration
-- gives them, so nothing changes for existing events.
--
-- This file is RE-RUNNABLE: every statement is safe to run a second time, and it only reads bookings_legacy (the
-- table 0015 set aside). That matters because D1's documentation is silent on whether a migration file is atomic
-- (see 0015), so a run that stopped half-way must be able to start again and finish. For the same reason it has no
-- ALTER TABLE ... ADD COLUMN (a second run would fail on the existing column): the settings that would have been
-- new events columns live in side tables instead. The legacy table is dropped by 0017, not here.
--
-- event_layout: one row per event. capacity is the number of places per lane per time (1 to 50), identity_limit the
-- number of bookings one identity (one dog and handler) may hold in the event (1 to 20), and config_rev a counter
-- that every edit of the lanes, the capacity or the limit must increase in the same batch, which is how a booking
-- request notices that the layout it read has since been edited (src/server/db-guard.ts, scheduleUnchanged).
--
-- event_lanes: the lanes of an event in order (position 1 to 10). A lane's name is unique within the event ignoring
-- ASCII case, so an event cannot have two unnamed lanes either (the application also makes every lane of a
-- multi-lane event named). A booking points at its lane without ON DELETE CASCADE: a lane that still has bookings
-- cannot be deleted by mistake. Deleting an event still works, because its bookings go in the same statement.
--
-- event_template_layout and event_template_lanes are the same for event templates. An event stores a COPY of the
-- template's layout, as it does for the rest of the template.
--
-- bookings, final columns: the lane, the place (1 up), up to four field values (value_1 is required; the booking
-- form has two fields so far, dog and handler, kept in value_1 and value_2) and the identity: identity_key is the
-- identity fields' keys (identityKey() in src/core/identity.ts) joined with U+001F, a character the booking form
-- refuses so it can never be part of a value, and identity_seq numbers an identity's bookings in the event (1 to
-- identity_limit). The unique indexes are the rules the database enforces: one booking per place, one booking per
-- identity and number, one per idempotency key in an event, one per token. A second booking of one dog and handler
-- is therefore identity_seq 2, allowed only when the event's identity_limit is above 1.
--
-- The copy keeps every id, token, key and created_at. INSERT OR IGNORE makes it safe to repeat, and the statement
-- after it fails the migration if any legacy row is missing afterwards, because OR IGNORE would otherwise hide a
-- row that violated a constraint. A booking with no token (the column was nullable) is given a random one.
--
-- The three legacy index names (bookings_token, bookings_idempotency_key and the dog and handler one) are dropped so
-- the new table can reuse the first two names. On a re-run the same DROP removes the new table's indexes of those
-- names, and the CREATE ... IF NOT EXISTS at the end puts them back.
--
-- The AUTOINCREMENT high-water mark (the largest id ever issued, which can be above the largest id still present) is
-- carried over through sqlite_sequence, so the id of a booking that was cleared is not issued again.

CREATE TABLE IF NOT EXISTS event_layout (
  event_id        INTEGER PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
  capacity        INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 50),
  identity_limit  INTEGER NOT NULL DEFAULT 1 CHECK (identity_limit BETWEEN 1 AND 20),
  config_rev      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS event_lanes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id  INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  position  INTEGER NOT NULL CHECK (position BETWEEN 1 AND 10),
  name      TEXT    NOT NULL DEFAULT '' CHECK (length(name) <= 40),
  UNIQUE (event_id, position)
);

CREATE UNIQUE INDEX IF NOT EXISTS event_lanes_name ON event_lanes (event_id, lower(name));

CREATE TABLE IF NOT EXISTS event_template_layout (
  template_id     INTEGER PRIMARY KEY REFERENCES event_templates (id) ON DELETE CASCADE,
  capacity        INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 50),
  identity_limit  INTEGER NOT NULL DEFAULT 1 CHECK (identity_limit BETWEEN 1 AND 20)
);

CREATE TABLE IF NOT EXISTS event_template_lanes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id  INTEGER NOT NULL REFERENCES event_templates (id) ON DELETE CASCADE,
  position     INTEGER NOT NULL CHECK (position BETWEEN 1 AND 10),
  name         TEXT    NOT NULL DEFAULT '' CHECK (length(name) <= 40),
  UNIQUE (template_id, position)
);

CREATE UNIQUE INDEX IF NOT EXISTS event_template_lanes_name ON event_template_lanes (template_id, lower(name));

INSERT OR IGNORE INTO event_layout (event_id) SELECT id FROM events;

INSERT INTO event_lanes (event_id, position, name)
  SELECT id, 1, '' FROM events WHERE NOT EXISTS (SELECT 1 FROM event_lanes WHERE event_lanes.event_id = events.id);

INSERT OR IGNORE INTO event_template_layout (template_id) SELECT id FROM event_templates;

INSERT INTO event_template_lanes (template_id, position, name)
  SELECT id, 1, '' FROM event_templates WHERE NOT EXISTS (SELECT 1 FROM event_template_lanes WHERE event_template_lanes.template_id = event_templates.id);

DROP INDEX IF EXISTS bookings_token;

DROP INDEX IF EXISTS bookings_idempotency_key;

DROP INDEX IF EXISTS bookings_one_run_per_dog_handler_keys;

CREATE TABLE IF NOT EXISTS bookings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  lane_id          INTEGER NOT NULL REFERENCES event_lanes (id),
  slot_start_utc   TEXT    NOT NULL,
  place            INTEGER NOT NULL DEFAULT 1 CHECK (place >= 1),
  value_1          TEXT    NOT NULL CHECK (trim(value_1) <> ''),
  value_2          TEXT    NOT NULL DEFAULT '',
  value_3          TEXT    NOT NULL DEFAULT '',
  value_4          TEXT    NOT NULL DEFAULT '',
  identity_key     TEXT    NOT NULL,
  identity_seq     INTEGER NOT NULL DEFAULT 1 CHECK (identity_seq >= 1),
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  token            TEXT    NOT NULL,
  idempotency_key  TEXT,
  CHECK (substr(slot_start_utc, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(slot_start_utc, 11) GLOB 'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  CHECK (substr(created_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(created_at, 11) GLOB 'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
);

INSERT OR IGNORE INTO bookings (id, event_id, lane_id, slot_start_utc, place, value_1, value_2, identity_key, identity_seq, created_at, token, idempotency_key)
  SELECT l.id, l.event_id, (SELECT id FROM event_lanes WHERE event_id = l.event_id AND position = 1), l.slot_start_utc, 1,
         l.dog_name, l.handler_name, l.dog_key || char(31) || l.handler_key, 1, l.created_at,
         COALESCE(l.token, lower(hex(randomblob(16)))), l.idempotency_key
  FROM bookings_legacy AS l;

SELECT CASE WHEN (SELECT COUNT(*) FROM bookings_legacy) = (SELECT COUNT(*) FROM bookings WHERE id IN (SELECT id FROM bookings_legacy)) THEN 1 ELSE abs(-9223372036854775808) END;

INSERT INTO sqlite_sequence (name, seq)
  SELECT 'bookings', seq FROM sqlite_sequence
  WHERE name = 'bookings_legacy' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'bookings');

UPDATE sqlite_sequence SET seq = max(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'bookings_legacy'), 0)) WHERE name = 'bookings';

CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_per_place ON bookings (event_id, lane_id, slot_start_utc, place);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_identity_seq ON bookings (event_id, identity_key, identity_seq);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_idempotency_key ON bookings (event_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_token ON bookings (token);

CREATE INDEX IF NOT EXISTS bookings_lane_id ON bookings (lane_id);
