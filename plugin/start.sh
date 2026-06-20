#!/bin/bash
# Touch Portal launches plugins without a login shell, so PATH usually lacks
# node (Homebrew / nvm installs). Locate node ourselves, then run plugin.js.
DIR="$(cd "$(dirname "$0")" && pwd)"

# Try to pull in a normal PATH from the login shell (covers Homebrew & system).
if [ -r "$HOME/.zprofile" ]; then . "$HOME/.zprofile" 2>/dev/null; fi
if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" 2>/dev/null; fi
if [ -r "$HOME/.profile" ]; then . "$HOME/.profile" 2>/dev/null; fi

NODE=""
for p in \
    "$(command -v node 2>/dev/null)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node ; do
    if [ -n "$p" ] && [ -x "$p" ]; then NODE="$p"; break; fi
done

if [ -z "$NODE" ]; then
    echo "start.sh: could not find node. Install Node.js or edit start.sh." >&2
    exit 127
fi

exec "$NODE" "$DIR/plugin.js"
