"""Attach email/phone/essential/telework flags to employees already in the database.

    python load_contacts.py contacts.csv

CSV header (any subset after userId):
    userId,email,phone,isEssential,teleworkEligible
    482917,naomi@example.com,+15555550101,yes,no

Safe to re-run. It never changes location_consent.
Needs DATABASE_URL set (use the External Database URL when running from your own computer).
"""
import csv
import sys

import server

if len(sys.argv) != 2:
    raise SystemExit(__doc__)
server.init_db()
with open(sys.argv[1], newline="", encoding="utf-8-sig") as f:
    result = server.update_contacts(list(csv.DictReader(f)))
print(f"Updated {result['updated']} of {result['received']}; rejected {result['rejectedCount']}")
for line in result["rejected"]:
    print("  ", line)
server.get_pool().close()