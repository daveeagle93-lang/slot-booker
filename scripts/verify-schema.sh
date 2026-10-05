#!/usr/bin/env bash
# Applies the migrations to a throwaway local D1 and checks the schema's
# constraints. Exits non-zero if any expectation fails. Run from anywhere.
set -u
cd "$(dirname "$0")/.."

DB=slot-booker-db
STATE=$(mktemp -d)
trap 'rm -rf "$STATE"' EXIT
FAILS=0

wr() { npx wrangler d1 "$@" --local --persist-to "$STATE"; }
sql() { wr execute "$DB" --command "$1" --json 2>&1; }
# key TEXT: the application's identity key (src/core/identity.ts), so SQL need not know Unicode rules
key() { node -e 'import("./src/core/identity.ts").then(m => process.stdout.write(m.identityKey(process.argv[1])))' -- "$1"; }

# expect_ok LABEL SQL
expect_ok() {
  if out=$(sql "$2") && ! grep -q '"success": false' <<<"$out"; then echo "PASS (accepted): $1"
  else echo "FAIL (should be accepted): $1"; echo "$out" | tail -5; FAILS=$((FAILS + 1)); fi
}
# expect_fail LABEL SQL ERROR_TEXT: must fail with the given error text
expect_fail() {
  out=$(sql "$2")
  if grep -q "$3" <<<"$out"; then echo "PASS (rejected, $3): $1"
  else echo "FAIL (should be rejected with '$3'): $1"; echo "$out" | tail -5; FAILS=$((FAILS + 1)); fi
}
# expect_count LABEL SQL EXPECTED
expect_count() {
  got=$(sql "$2" | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
  if [ "$got" = "$3" ]; then echo "PASS (count=$3): $1"
  else echo "FAIL ($1): expected $3, got '$got'"; FAILS=$((FAILS + 1)); fi
}

wr migrations apply "$DB" || { echo "FAIL: migration did not apply"; exit 1; }

expect_count "foreign keys are on" "SELECT foreign_keys AS n FROM pragma_foreign_keys" 1

EV="INSERT INTO events (name, start_utc, end_utc, session_minutes, venue_postcode) VALUES"
EVS="INSERT INTO events (name, start_utc, end_utc, session_minutes, venue_postcode, slug) VALUES"
expect_ok "insert event 1 (with slug)" "$EVS ('Test A', '2026-03-14T09:00:00Z', '2026-03-14T16:00:00Z', 15, 'AB1 2CD', 'slug-a-aaaaaaaaaaaaaa')"
expect_ok "insert event 2 (different slug)" "$EVS ('Test B', '2026-06-13T09:00:00Z', '2026-06-13T16:00:00Z', 15, 'AB1 2CD', 'slug-b-bbbbbbbbbbbbbb')"
expect_ok "insert event 3 (NULL slug)" "$EV ('Test C', '2026-09-12T09:00:00Z', '2026-09-12T16:00:00Z', 15, 'AB1 2CD')"
expect_ok "a second NULL-slug event coexists" "$EV ('Test D', '2026-10-10T09:00:00Z', '2026-10-10T16:00:00Z', 15, 'AB1 2CD')"
expect_fail "duplicate slug" "$EVS ('Dup', '2026-11-14T09:00:00Z', '2026-11-14T16:00:00Z', 15, 'AB1 2CD', 'slug-a-aaaaaaaaaaaaaa')" "UNIQUE constraint failed"
expect_count "two events with different slugs" "SELECT count(DISTINCT slug) AS n FROM events WHERE slug IS NOT NULL" 2
expect_ok "insert breaks" "INSERT INTO breaks (event_id, start_utc, end_utc) VALUES (1, '2026-03-14T12:00:00Z', '2026-03-14T13:00:00Z'), (1, '2026-03-14T14:00:00Z', '2026-03-14T14:15:00Z')"

BK="INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key) VALUES"
# row EVENT SLOT DOG HANDLER: one VALUES tuple with keys computed from the names
row() { echo "($1, '$2', '$3', '$4', '$(key "$3")', '$(key "$4")')"; }
expect_ok "first booking" "$BK $(row 1 '2026-03-14T09:00:00Z' 'Rex' 'Sam Jones')"
expect_fail "duplicate (event, slot)" "$BK $(row 1 '2026-03-14T09:00:00Z' 'Fido' 'Ann Lee')" "UNIQUE constraint failed"
expect_fail "duplicate dog+handler, exact" "$BK $(row 1 '2026-03-14T09:15:00Z' 'Rex' 'Sam Jones')" "UNIQUE constraint failed"
expect_fail "duplicate dog+handler, case/whitespace variants" "$BK $(row 1 '2026-03-14T09:15:00Z' ' rex ' 'sam jones')" "UNIQUE constraint failed"
expect_ok "same handler, different dog, same event" "$BK $(row 1 '2026-03-14T09:15:00Z' 'Fido' 'Sam Jones')"
expect_ok "same dog+handler, different event" "$BK $(row 2 '2026-06-13T09:00:00Z' 'Rex' 'Sam Jones')"
expect_ok "no ab+c / a+bc collision" "$BK $(row 1 '2026-03-14T09:30:00Z' 'ab' 'c'), $(row 1 '2026-03-14T09:45:00Z' 'a' 'bc')"
expect_fail "blank dog name" "$BK $(row 1 '2026-03-14T10:00:00Z' '  ' 'Ann Lee')" "CHECK constraint failed"
expect_fail "bad booking timestamp format" "$BK $(row 1 '2026-03-14 10:00' 'Bo' 'Ann Lee')" "CHECK constraint failed"
expect_fail "booking for missing event" "$BK $(row 99 '2026-03-14T10:00:00Z' 'Bo' 'Ann Lee')" "FOREIGN KEY constraint failed"

# Unicode identity: keys come from identityKey(), display columns keep the text as entered.
expect_ok "Zoë booked" "$BK $(row 1 '2026-03-14T10:15:00Z' 'Zoë' 'Pat Kay')"
expect_fail "Zoë vs ZOË (same event and handler) collides" "$BK $(row 1 '2026-03-14T10:30:00Z' 'ZOË' 'Pat Kay')" "UNIQUE constraint failed"
expect_fail "precomposed vs decomposed ë collides" "$BK $(row 1 '2026-03-14T10:30:00Z' $'Zoe\xcc\x88' 'Pat Kay')" "UNIQUE constraint failed"
expect_ok "same Zoë dog, different handler" "$BK $(row 1 '2026-03-14T10:30:00Z' 'Zoë' 'Lee Ray')"
expect_ok "ZOË in another event" "$BK $(row 3 '2026-09-12T09:00:00Z' 'ZOË' 'Pat Kay')"
expect_count "display column keeps text as entered" "SELECT count(*) AS n FROM bookings WHERE dog_name = 'ZOË'" 1
expect_count "old ASCII-only index is gone" "SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'bookings_one_run_per_dog_handler'" 0
expect_ok "booking with forgotten keys (first)" "INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name) VALUES (3, '2026-09-12T09:15:00Z', 'Mo', 'Al')"
expect_fail "booking with forgotten keys (second) fails loudly" "INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name) VALUES (3, '2026-09-12T09:30:00Z', 'Bo', 'Cy')" "UNIQUE constraint failed"

# Booking tokens (0004): unique when set, nullable otherwise.
BKT="INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key, token) VALUES"
expect_ok "booking with a token" "$BKT (3, '2026-09-12T11:00:00Z', 'Ta', 'Ua', 'ta', 'ua', 'token-aaaaaaaaaaaaaaaa')"
expect_fail "duplicate token" "$BKT (3, '2026-09-12T11:15:00Z', 'Tb', 'Ub', 'tb', 'ub', 'token-aaaaaaaaaaaaaaaa')" "UNIQUE constraint failed"
expect_ok "bookings with different tokens coexist" "$BKT (3, '2026-09-12T11:15:00Z', 'Tb', 'Ub', 'tb', 'ub', 'token-bbbbbbbbbbbbbbbb')"
expect_ok "two NULL-token bookings coexist" "$BK $(row 3 '2026-09-12T11:30:00Z' 'Tc' 'Uc'), $(row 3 '2026-09-12T11:45:00Z' 'Td' 'Ud')"
expect_count "both NULL-token bookings stored" "SELECT count(*) AS n FROM bookings WHERE event_id = 3 AND dog_key IN ('tc', 'td') AND token IS NULL" 2

# Idempotency keys (0005): unique within an event when set, nullable otherwise.
BKI="INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key, idempotency_key) VALUES"
expect_ok "booking with an idempotency key" "$BKI (3, '2026-09-12T12:00:00Z', 'Ia', 'Ja', 'ia', 'ja', 'idem-aaaaaaaaaaaaaaaa')"
expect_fail "duplicate idempotency key, same event" "$BKI (3, '2026-09-12T12:15:00Z', 'Ib', 'Jb', 'ib', 'jb', 'idem-aaaaaaaaaaaaaaaa')" "UNIQUE constraint failed"
expect_ok "same idempotency key, different event" "$BKI (1, '2026-03-14T11:00:00Z', 'Ia', 'Ja', 'ia', 'ja', 'idem-aaaaaaaaaaaaaaaa')"
expect_ok "different idempotency keys coexist" "$BKI (3, '2026-09-12T12:15:00Z', 'Ib', 'Jb', 'ib', 'jb', 'idem-bbbbbbbbbbbbbbbb')"
expect_count "NULL-key bookings coexist alongside keyed ones" "SELECT count(*) AS n FROM bookings WHERE event_id = 3 AND dog_key IN ('tc', 'td') AND idempotency_key IS NULL" 2

# Login attempts (0006): one row per hashed client key, all columns required.
LA="INSERT INTO login_attempts (key, attempts, window_start) VALUES"
expect_ok "login attempt row" "$LA ('hash-a', 1, 1800000000)"
expect_fail "duplicate login attempt key" "$LA ('hash-a', 1, 1800000900)" "UNIQUE constraint failed"
expect_ok "different login attempt key" "$LA ('hash-b', 3, 1800000000)"
expect_fail "NULL login attempt key" "INSERT INTO login_attempts (key, attempts, window_start) VALUES (NULL, 1, 1800000000)" "NOT NULL constraint failed"
expect_fail "NULL attempts" "INSERT INTO login_attempts (key, window_start) VALUES ('hash-c', 1800000000)" "NOT NULL constraint failed"
expect_fail "NULL window_start" "INSERT INTO login_attempts (key, attempts) VALUES ('hash-d', 1)" "NOT NULL constraint failed"
expect_count "login attempts stored" "SELECT count(*) AS n FROM login_attempts" 2

# Login attempts index (0007): the purge by age must search the index, not scan the table.
expect_count "window_start index exists" "SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'login_attempts_window_start'" 1
# Keep this statement in step with PURGE_SQL in src/server/auth/ratelimit.ts (a unit test checks the real one).
PURGE="DELETE FROM login_attempts WHERE rowid IN (SELECT rowid FROM login_attempts WHERE window_start < 0 LIMIT 100)"
plan=$(sql "EXPLAIN QUERY PLAN $PURGE")
if grep -q 'INDEX login_attempts_window_start' <<<"$plan" && ! grep -q 'SCAN login_attempts' <<<"$plan"; then echo "PASS: purge uses the window_start index"
else echo "FAIL (purge query plan should use the index and not SCAN login_attempts):"; echo "$plan" | tail -15; FAILS=$((FAILS + 1)); fi

# Break labels (0008): NOT NULL, default empty, loose length backstop.
expect_count "existing breaks default to an empty label" "SELECT count(*) AS n FROM breaks WHERE event_id = 1 AND label = ''" 2
expect_ok "break with a label" "INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES (2, '2026-06-13T12:00:00Z', '2026-06-13T13:00:00Z', 'Lunch')"
expect_ok "break with a 100-character label" "INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES (2, '2026-06-13T14:00:00Z', '2026-06-13T14:15:00Z', replace(hex(zeroblob(50)), '0', 'x'))"
expect_fail "break with a 101-character label" "INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES (2, '2026-06-13T15:00:00Z', '2026-06-13T15:15:00Z', replace(hex(zeroblob(50)), '0', 'x') || 'y')" "CHECK constraint failed"
expect_fail "NULL break label" "INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES (2, '2026-06-13T15:00:00Z', '2026-06-13T15:15:00Z', NULL)" "NOT NULL constraint failed"

# Event idempotency keys (0008): unique across events when set, nullable otherwise.
EVI="INSERT INTO events (name, start_utc, end_utc, session_minutes, venue_postcode, slug, idempotency_key) VALUES"
expect_count "events from before the key have none" "SELECT count(*) AS n FROM events WHERE slug IN ('slug-a-aaaaaaaaaaaaaa', 'slug-b-bbbbbbbbbbbbbb') AND idempotency_key IS NULL" 2
expect_ok "event with an idempotency key" "$EVI ('Keyed A', '2026-12-12T09:00:00Z', '2026-12-12T16:00:00Z', 15, 'AB1 2CD', 'slug-k-aaaaaaaaaaaaaa', 'evkey-aaaaaaaaaaaaaaaa')"
expect_fail "duplicate event idempotency key" "$EVI ('Keyed B', '2026-12-19T09:00:00Z', '2026-12-19T16:00:00Z', 15, 'AB1 2CD', 'slug-k-bbbbbbbbbbbbbb', 'evkey-aaaaaaaaaaaaaaaa')" "UNIQUE constraint failed"
expect_ok "different event idempotency keys coexist" "$EVI ('Keyed B', '2026-12-19T09:00:00Z', '2026-12-19T16:00:00Z', 15, 'AB1 2CD', 'slug-k-bbbbbbbbbbbbbb', 'evkey-bbbbbbbbbbbbbbbb')"
expect_ok "two NULL-key events coexist alongside keyed ones" "$EVI ('Unkeyed A', '2027-01-09T09:00:00Z', '2027-01-09T16:00:00Z', 15, 'AB1 2CD', 'slug-n-aaaaaaaaaaaaaa', NULL), ('Unkeyed B', '2027-01-16T09:00:00Z', '2027-01-16T16:00:00Z', 15, 'AB1 2CD', 'slug-n-bbbbbbbbbbbbbb', NULL)"

# Site settings (0009): a singleton row inserted by the migration; theme colours NULL or lower-case #rrggbb.
expect_count "the migration inserted the settings row" "SELECT count(*) AS n FROM site_settings WHERE id = 1 AND club_name = '' AND website_url = '' AND theme_primary IS NULL AND theme_accent IS NULL" 1
expect_fail "a second settings row" "INSERT INTO site_settings (id) VALUES (2)" "CHECK constraint failed"
expect_fail "settings id 1 twice" "INSERT INTO site_settings (id) VALUES (1)" "UNIQUE constraint failed"
expect_fail "NULL club name" "UPDATE site_settings SET club_name = NULL" "NOT NULL constraint failed"
expect_ok "theme colours set" "UPDATE site_settings SET theme_primary = '#0a1b2c', theme_accent = '#ffffff'"
expect_ok "theme colours back to NULL" "UPDATE site_settings SET theme_primary = NULL, theme_accent = NULL"
expect_fail "upper-case theme colour" "UPDATE site_settings SET theme_primary = '#0A1B2C'" "CHECK constraint failed"
expect_fail "short theme colour" "UPDATE site_settings SET theme_accent = '#fff'" "CHECK constraint failed"
expect_fail "theme colour with a seventh digit" "UPDATE site_settings SET theme_accent = '#0a1b2c0'" "CHECK constraint failed"
expect_fail "theme colour without the #" "UPDATE site_settings SET theme_primary = '0a1b2c'" "CHECK constraint failed"
expect_fail "settings timestamp in the wrong shape" "UPDATE site_settings SET updated_at = '2026-10-05 12:00'" "CHECK constraint failed"

# Site logo (0009): singleton, allow-listed type, BLOB of 1 to 204800 bytes, sides 1 to 512, 64 lower-case hex digest.
LG="INSERT INTO site_logo (id, content_type, bytes, width, height, sha256) VALUES"
SHA=$(printf 'a%.0s' $(seq 64))
expect_count "no logo to begin with" "SELECT count(*) AS n FROM site_logo" 0
expect_ok "a png logo" "$LG (1, 'image/png', x'010203', 10, 10, '$SHA')"
expect_fail "a second logo row" "$LG (1, 'image/png', x'010203', 10, 10, '$SHA')" "UNIQUE constraint failed"
expect_fail "logo id 2" "$LG (2, 'image/png', x'010203', 10, 10, '$SHA')" "CHECK constraint failed"
expect_ok "delete the logo" "DELETE FROM site_logo"
for ct in image/jpeg image/webp; do
  expect_ok "a $ct logo" "$LG (1, '$ct', x'010203', 10, 10, '$SHA')"
  expect_ok "delete the $ct logo" "DELETE FROM site_logo"
done
for ct in image/svg+xml image/gif text/html IMAGE/PNG; do
  expect_fail "logo content type $ct" "$LG (1, '$ct', x'010203', 10, 10, '$SHA')" "CHECK constraint failed"
done
expect_fail "empty logo bytes" "$LG (1, 'image/png', x'', 10, 10, '$SHA')" "CHECK constraint failed"
expect_fail "logo bytes as text" "$LG (1, 'image/png', 'abc', 10, 10, '$SHA')" "CHECK constraint failed"
expect_fail "logo of 204801 bytes" "$LG (1, 'image/png', zeroblob(204801), 10, 10, '$SHA')" "CHECK constraint failed"
expect_ok "logo of 204800 bytes" "$LG (1, 'image/png', zeroblob(204800), 512, 512, '$SHA')"
expect_ok "delete the large logo" "DELETE FROM site_logo"
expect_fail "logo 513 wide" "$LG (1, 'image/png', x'010203', 513, 10, '$SHA')" "CHECK constraint failed"
expect_fail "logo 0 tall" "$LG (1, 'image/png', x'010203', 10, 0, '$SHA')" "CHECK constraint failed"
expect_fail "upper-case logo digest" "$LG (1, 'image/png', x'010203', 10, 10, '$(printf 'A%.0s' $(seq 64))')" "CHECK constraint failed"
expect_fail "short logo digest" "$LG (1, 'image/png', x'010203', 10, 10, 'abc')" "CHECK constraint failed"
expect_fail "NULL logo bytes" "$LG (1, 'image/png', NULL, 10, 10, '$SHA')" "NOT NULL constraint failed"

expect_fail "trailing junk after timestamp" "$BK $(row 1 '2026-03-14T10:00:00Zx' 'Bo' 'Ann Lee')" "CHECK constraint failed"
expect_fail "bad event timestamp format" "$EV ('Bad', '2026-03-14 09:00', '2026-03-14T16:00:00Z', 15, 'AB1 2CD')" "CHECK constraint failed"
expect_fail "event end == start" "$EV ('Bad', '2026-03-14T09:00:00Z', '2026-03-14T09:00:00Z', 15, 'AB1 2CD')" "CHECK constraint failed"
expect_fail "event end < start" "$EV ('Bad', '2026-03-14T09:00:00Z', '2026-03-14T08:00:00Z', 15, 'AB1 2CD')" "CHECK constraint failed"
expect_fail "break end <= start" "INSERT INTO breaks (event_id, start_utc, end_utc) VALUES (1, '2026-03-14T12:00:00Z', '2026-03-14T12:00:00Z')" "CHECK constraint failed"

expect_ok "delete event 1" "DELETE FROM events WHERE id = 1"
expect_count "cascade: breaks removed" "SELECT count(*) AS n FROM breaks WHERE event_id = 1" 0
expect_count "cascade: bookings removed" "SELECT count(*) AS n FROM bookings WHERE event_id = 1" 0
expect_count "other event's booking kept" "SELECT count(*) AS n FROM bookings WHERE event_id = 2" 1

# Backfill: a database holding rows from before 0003 / 0004 gets random slugs and tokens (0005 and 0008 leave keys NULL, 0008 leaves break labels empty, 0009 adds the settings row).
OLD=$(mktemp -d)
trap 'rm -rf "$STATE" "$OLD"' EXIT
old() { npx wrangler d1 execute "$DB" --local --persist-to "$OLD" "$@" 2>&1; }
old --file migrations/0001_init.sql >/dev/null && old --file migrations/0002_identity_keys.sql >/dev/null \
  && old --command "INSERT INTO events (name, start_utc, end_utc, session_minutes, venue_postcode) VALUES ('Old', '2026-03-14T09:00:00Z', '2026-03-14T16:00:00Z', 15, 'AB1 2CD')" >/dev/null \
  && old --file migrations/0003_event_slug.sql >/dev/null \
  && old --command "INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key) VALUES (1, '2026-03-14T09:00:00Z', 'Rex', 'Sam Jones', 'rex', 'sam jones'), (1, '2026-03-14T09:15:00Z', 'Fido', 'Ann Lee', 'fido', 'ann lee')" >/dev/null \
  && old --file migrations/0004_booking_token.sql >/dev/null \
  && old --file migrations/0005_booking_idempotency_key.sql >/dev/null \
  && old --command "INSERT INTO breaks (event_id, start_utc, end_utc) VALUES (1, '2026-03-14T12:00:00Z', '2026-03-14T13:00:00Z')" >/dev/null \
  && old --file migrations/0006_login_attempts.sql >/dev/null && old --file migrations/0007_login_attempts_index.sql >/dev/null \
  && old --file migrations/0008_break_labels_event_idempotency.sql >/dev/null \
  && old --file migrations/0009_site_settings.sql >/dev/null || { echo "FAIL: backfill setup"; FAILS=$((FAILS + 1)); }
got=$(old --command "SELECT count(*) AS n FROM events WHERE slug GLOB '[0-9a-f]*' AND length(slug) = 32" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "1" ]; then echo "PASS (count=1): pre-existing event backfilled with a 32-hex slug"
else echo "FAIL (backfill): expected 1, got '$got'"; FAILS=$((FAILS + 1)); fi
got=$(old --command "SELECT count(*) AS n FROM bookings WHERE token NOT GLOB '*[^0-9a-f]*' AND length(token) = 32" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "2" ]; then echo "PASS (count=2): pre-existing bookings backfilled with 32-hex tokens"
else echo "FAIL (token backfill): expected 2, got '$got'"; FAILS=$((FAILS + 1)); fi
got=$(old --command "SELECT count(DISTINCT token) AS n FROM bookings" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "2" ]; then echo "PASS (count=2): backfilled tokens are distinct"
else echo "FAIL (token backfill distinct): expected 2, got '$got'"; FAILS=$((FAILS + 1)); fi
got=$(old --command "SELECT count(*) AS n FROM bookings WHERE idempotency_key IS NULL" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "2" ]; then echo "PASS (count=2): pre-existing bookings have no idempotency key"
else echo "FAIL (idempotency key on old rows): expected 2, got '$got'"; FAILS=$((FAILS + 1)); fi
got=$(old --command "SELECT count(*) AS n FROM breaks WHERE label = ''" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "1" ]; then echo "PASS (count=1): pre-existing break survived 0008 with an empty label"
else echo "FAIL (break label on old rows): expected 1, got '$got'"; FAILS=$((FAILS + 1)); fi
got=$(old --command "SELECT count(*) AS n FROM events WHERE idempotency_key IS NULL" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "1" ]; then echo "PASS (count=1): pre-existing event survived 0008 with no idempotency key"
else echo "FAIL (event key on old rows): expected 1, got '$got'"; FAILS=$((FAILS + 1)); fi
got=$(old --command "SELECT count(*) AS n FROM site_settings WHERE id = 1" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "1" ]; then echo "PASS (count=1): 0009 added the settings row to a database with earlier data"
else echo "FAIL (settings row on old database): expected 1, got '$got'"; FAILS=$((FAILS + 1)); fi

if [ "$FAILS" -ne 0 ]; then echo "$FAILS check(s) FAILED"; exit 1; fi
echo "All schema checks passed"
