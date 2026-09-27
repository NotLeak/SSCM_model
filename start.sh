#!/usr/bin/env sh
cd "$(dirname "$0")"
echo "SCLM server starting... http://127.0.0.1:8641"
node server.js
