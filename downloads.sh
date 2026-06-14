#!/usr/bin/env bash
# Show GitHub Release download counts for this extension.
# Usage: ./downloads.sh                 (uses the repo below)
#        ./downloads.sh owner/repo      (any other repo)
set -euo pipefail

REPO="${1:-adeshwarali/extract-active-drum-channels}"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
curl -fsSL "https://api.github.com/repos/${REPO}/releases" -o "$TMP"

python3 - "$REPO" "$TMP" <<'PY'
import json, sys
repo, path = sys.argv[1], sys.argv[2]
data = json.load(open(path))
if isinstance(data, dict):
    print(f"API message: {data.get('message', '(unexpected response)')}")
    sys.exit(0)
if not data:
    print(f"No releases found for {repo}.")
    sys.exit(0)

print(f"Downloads for {repo}:")
total = 0
for rel in data:
    tag = " (latest)" if not rel.get("prerelease") and not rel.get("draft") else ""
    print(f"\n  {rel['tag_name']} — {rel.get('name','')}{tag}")
    assets = rel.get("assets", [])
    if not assets:
        print("    (no files attached)")
    for a in assets:
        print(f"    {a['name']}: {a['download_count']} downloads")
        total += a["download_count"]
print(f"\nTOTAL across all releases: {total}")
PY
