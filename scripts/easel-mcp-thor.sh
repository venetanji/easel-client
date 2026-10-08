#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
if [ "${1:-}" = stdio ]; then
    unset EASEL_API_KEY EASEL_KEY EASEL_MEDIA_MODELS HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NODE_OPTIONS NODE_USE_ENV_PROXY
    export EASEL_API_KEY=''
    export EASEL_BASE_URL='http://easel.tail.ait4x.org'
    export EASEL_PRIVATE_BASE_URL="$EASEL_BASE_URL"
    export EASEL_PRIVATE_ADDRESS='100.64.0.7'
    export EASEL_MEDIA_OUTPUT_ROOTS=$(node - "$root" <<'NODE'
const fs = require('node:fs');
const root = process.argv[2];
const prefixes = root.includes('/.openclaw-gateway/') ? ['/home/venetanji/.openclaw-gateway'] : ['/home/venetanji/.openclaw', '/home/node/.openclaw'];
const workspaces = ['workspace', 'workspace-personal', 'workspace-sd2112', 'workspace-sd5913', 'workspace-slidemaker', 'workspace-tetrilaunch', 'workspace-creative-skills'];
const roots = prefixes.flatMap(prefix => workspaces.map(workspace => prefix + '/' + workspace)).filter(path => fs.existsSync(path));
if (!roots.length) throw new Error('No shared requester workspace is mounted.');
process.stdout.write(JSON.stringify(roots));
NODE
    )
    exec node "$root/current/node_modules/@easel/media-mcp/dist/cli.js"
fi
exec node "$root/current/node_modules/mcporter/dist/cli.js" --config "$root/mcporter.json" "$@"
