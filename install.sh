#!/usr/bin/env bash
# Install the graph, bakeoff and dag skills into Claude Code.
#
#   ./install.sh                 all three skills
#   ./install.sh graph dag       only the ones you name
#   ./install.sh --with-gate     also install the optional dag-gate plugin
#   ./install.sh --uninstall dag remove what this script installed (no name = all three)
#
# Skills go to $CLAUDE_HOME/skills/<name> (CLAUDE_HOME defaults to ~/.claude).
# An existing folder with the same name is moved to $CLAUDE_HOME/backups/, never deleted.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
ALL=(graph bakeoff dag)
STAMP="$(date +%Y%m%d-%H%M%S)"

with_gate=0
uninstall=0
picked=()
for arg in "$@"; do
  case "$arg" in
    --with-gate) with_gate=1 ;;
    --uninstall) uninstall=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    graph|bakeoff|dag) picked+=("$arg") ;;
    all) picked=("${ALL[@]}") ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 64 ;;
  esac
done
[ ${#picked[@]} -eq 0 ] && picked=("${ALL[@]}")

place() {  # place <source dir> <dest dir>
  local from="$1" to="$2"
  if [ -e "$to" ]; then
    if diff -rq -x __pycache__ "$from" "$to" >/dev/null 2>&1; then
      echo "  = $to (already current)"
      return
    fi
    # Back up outside skills/: Claude Code loads every folder there that has a SKILL.md.
    local bak="$CLAUDE_HOME/backups/$(basename "$(dirname "$to")")-$(basename "$to").bak-$STAMP"
    mkdir -p "$(dirname "$bak")"
    mv "$to" "$bak"
    echo "  ~ moved the old copy to $bak"
  fi
  mkdir -p "$(dirname "$to")"
  cp -R "$from" "$to"
  rm -rf "$to"/scripts/__pycache__ "$to"/tests/__pycache__
  diff -rq -x __pycache__ "$from" "$to" >/dev/null || { echo "  ! copy of $to does not match the source" >&2; exit 1; }
  echo "  + $to"
}

remove() {
  if [ -e "$1" ]; then rm -rf "$1"; echo "  - $1"; else echo "  . $1 (not installed)"; fi
}

if [ $uninstall -eq 1 ]; then
  echo "Removing from $CLAUDE_HOME"
  for s in "${picked[@]}"; do remove "$CLAUDE_HOME/skills/$s"; done
  [ $with_gate -eq 1 ] && remove "$CLAUDE_HOME/local-mods/dag-gate"
  exit 0
fi

command -v python3 >/dev/null || echo "note: python3 not found; the graph and dag scripts need Python 3.9+" >&2

echo "Installing into $CLAUDE_HOME"
for s in "${picked[@]}"; do place "$SRC/skills/$s" "$CLAUDE_HOME/skills/$s"; done

if [ $with_gate -eq 1 ]; then
  # The guard protects its own folder at this exact path, so install it here.
  place "$SRC/mods/dag-gate" "$CLAUDE_HOME/local-mods/dag-gate"
  cat <<EOF

dag-gate is a Claude Code plugin with a hooks module. To load it, add its folder to
CLAUDE_CODE_PLUGIN_DIRS in the "env" block of $CLAUDE_HOME/settings.json
(colon-separated if you already have one):

  "CLAUDE_CODE_PLUGIN_DIRS": "$CLAUDE_HOME/local-mods/dag-gate"

then restart Claude Code. /dag works without it: approve in your own terminal with
  python3 $CLAUDE_HOME/skills/dag/scripts/dag.py --spec <job>/dag.json approve <gate>
EOF
fi

cat <<EOF

Done. Start a new Claude Code session, then try:
  /graph task 0 = <context>  task 1 = <the deliverable>
  /bakeoff log
  /dag   (or ask: "make this a dag job")
EOF
