#!/usr/bin/env bash
# AI-tone gate for judge-facing prose. Fails on an em-dash (U+2014), an en-dash used as a range
# (U+2013), curly quotes, or a blocklisted marketing word in any tracked or untracked-but-not-ignored
# prose file. Prints the count of files scanned so a scan of nothing can never read as a pass.
# Portable: no mapfile, no grep -P, raw UTF-8 byte patterns, runs on macOS bash 3.2 and Ubuntu.
set -u

cd "$(git rev-parse --show-toplevel)" || exit 2

# Prose surfaces only. Code, corpora, the spike, and the saved third-party reference are excluded.
files=$(git ls-files --cached --others --exclude-standard -- \
  '*.md' 'docs/*.md' 'apps/web/src/**/*.html' 'apps/web/index.html' 'apps/web/src/copy/*' \
  | grep -v -e '^spike/' -e '^docs/aardvark-reference.html$' -e '^corpus/' -e '^LICENSE$' -e 'node_modules/' || true)

count=0
fail=0
for f in $files; do
  [ -f "$f" ] || continue
  count=$((count + 1))
  # em-dash E2 80 94, en-dash E2 80 93, curly quotes E2 80 9C / E2 80 9D / E2 80 98 / E2 80 99
  hits=$(LC_ALL=C grep -n -e $'\xE2\x80\x94' -e $'\xE2\x80\x93' -e $'\xE2\x80\x9C' -e $'\xE2\x80\x9D' -e $'\xE2\x80\x98' -e $'\xE2\x80\x99' -- "$f" || true)
  if [ -n "$hits" ]; then
    echo "AI-TONE FAIL (dash or curly quote) in $f:"; echo "$hits" | head -5; fail=1
  fi
  words=$(grep -n -i -w -E 'leverage|seamless|robust|comprehensive|unlock|cutting-edge|revolutionary|streamline|ecosystem|effortlessly|delve|elevate|empower|intuitive|transform|sophisticated|game-changing|supercharge' -- "$f" || true)
  if [ -n "$words" ]; then
    echo "AI-TONE FAIL (blocklist word) in $f:"; echo "$words" | head -5; fail=1
  fi
done

if [ "$count" -eq 0 ]; then
  echo "AI-TONE GATE: scanned 0 files. Refusing to pass a scan of nothing."
  exit 3
fi
if [ "$fail" -ne 0 ]; then
  echo "AI-TONE GATE: FAILED across $count prose file(s)."
  exit 1
fi
echo "AI-TONE GATE: PASSED across $count prose file(s)."
exit 0
