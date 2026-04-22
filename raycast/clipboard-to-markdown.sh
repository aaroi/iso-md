#!/usr/bin/env bash

# @raycast.schemaVersion 1
# @raycast.title Clipboard → Markdown
# @raycast.mode silent
# @raycast.packageName Clipboard Tools
# @raycast.icon 📝
# @raycast.description Convert rich text on the clipboard to Markdown, in place.
# @raycast.author Aaro Isosaari

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"

if ! command -v pandoc >/dev/null 2>&1; then
  echo "pandoc missing — run: brew install pandoc"
  exit 1
fi

html=$(
  osascript -e 'the clipboard as «class HTML»' 2>/dev/null \
    | sed -nE 's/^«data HTML([0-9A-Fa-f]*)».*$/\1/p' \
    | xxd -r -p
)

if [ -z "$html" ]; then
  echo "No rich text on clipboard"
  exit 0
fi

md=$(printf '%s' "$html" | pandoc -f html -t gfm-raw_html --wrap=none | python3 -c '
import sys, re
t = sys.stdin.read()
t = re.sub(r"\\([\[\]])", r"\1", t)
t = re.sub(r"\\$", "", t, flags=re.MULTILINE)
t = t.replace("\u00a0", " ")
sys.stdout.write(t)
')

printf '%s' "$md" | pbcopy

osascript -e 'tell application "System Events" to keystroke "v" using command down'

echo "✓ Pasted as Markdown"
