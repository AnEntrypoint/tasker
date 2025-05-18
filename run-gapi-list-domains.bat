@echo off
echo Starting Supabase Functions Server...

start /b supabase functions serve --no-verify-jwt

echo Waiting 10 seconds for server to initialize...
timeout /t 10 /nobreak > nul

echo Starting GAPI list domains client...
deno run -A ./gapi-list-domains-cli.js

echo Done! 