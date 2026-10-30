#!/bin/sh
# Only the shell owns stdout after each parser helper exits; Bun keeps extra stdio fds.
IFS= read -r hello || exit 1
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocol":"1.6.0","id":"raw-observer","version":"1.0.0","contributes":["policy"],"features":["policyObservations"]}}'
IFS= read -r ping || exit 1
meta=$("$1" -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1])._meta))' "$ping") || exit 1
printf '{"jsonrpc":"2.0","id":"subscribe","method":"capability.events.subscribe","params":{"types":["task","repo"]},"_meta":%s}\n' "$meta"
IFS= read -r subscribed || exit 1
printf '{"jsonrpc":"2.0","id":2,"result":{"ok":true,"uptimeS":0,"pid":%s}}\n' "$$"
if [ "$2" = blocked ]; then exec sleep 30; fi
exec 1>&-
exec sleep 30
