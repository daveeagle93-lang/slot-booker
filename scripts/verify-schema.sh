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

expect_fail "trailing junk after timestamp" "$BK $(row 1 '2026-03-14T10:00:00Zx' 'Bo' 'Ann Lee')" "CHECK constraint failed"
expect_fail "bad event timestamp format" "$EV ('Bad', '2026-03-14 09:00', '2026-03-14T16:00:00Z', 15, 'AB1 2CD')" "CHECK constraint failed"
expect_fail "event end == start" "$EV ('Bad', '2026-03-14T09:00:00Z', '2026-03-14T09:00:00Z', 15, 'AB1 2CD')" "CHECK constraint failed"
expect_fail "event end < start" "$EV ('Bad', '2026-03-14T09:00:00Z', '2026-03-14T08:00:00Z', 15, 'AB1 2CD')" "CHECK constraint failed"
expect_fail "break end <= start" "INSERT INTO breaks (event_id, start_utc, end_utc) VALUES (1, '2026-03-14T12:00:00Z', '2026-03-14T12:00:00Z')" "CHECK constraint failed"

expect_ok "delete event 1" "DELETE FROM events WHERE id = 1"
expect_count "cascade: breaks removed" "SELECT count(*) AS n FROM breaks WHERE event_id = 1" 0
expect_count "cascade: bookings removed" "SELECT count(*) AS n FROM bookings WHERE event_id = 1" 0
expect_count "other event's booking kept" "SELECT count(*) AS n FROM bookings WHERE event_id = 2" 1

# Backfill: a database holding rows from before 0003 / 0004 gets random slugs and tokens (and 0005 leaves keys NULL).
OLD=$(mktemp -d)
trap 'rm -rf "$STATE" "$OLD"' EXIT
old() { npx wrangler d1 execute "$DB" --local --persist-to "$OLD" "$@" 2>&1; }
old --file migrations/0001_init.sql >/dev/null && old --file migrations/0002_identity_keys.sql >/dev/null \
  && old --command "INSERT INTO events (name, start_utc, end_utc, session_minutes, venue_postcode) VALUES ('Old', '2026-03-14T09:00:00Z', '2026-03-14T16:00:00Z', 15, 'AB1 2CD')" >/dev/null \
  && old --file migrations/0003_event_slug.sql >/dev/null \
  && old --command "INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key) VALUES (1, '2026-03-14T09:00:00Z', 'Rex', 'Sam Jones', 'rex', 'sam jones'), (1, '2026-03-14T09:15:00Z', 'Fido', 'Ann Lee', 'fido', 'ann lee')" >/dev/null \
  && old --file migrations/0004_booking_token.sql >/dev/null \
  && old --file migrations/0005_booking_idempotency_key.sql >/dev/null || { echo "FAIL: backfill setup"; FAILS=$((FAILS + 1)); }
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

if [ "$FAILS" -ne 0 ]; then echo "$FAILS check(s) FAILED"; exit 1; fi
echo "All schema checks passed"
