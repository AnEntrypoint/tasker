@echo off
echo Setting environment variables...

set SUPABASE_URL=http://localhost:54321
set SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU
set SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0

echo Starting Supabase Functions Server...

rem Kill any existing supabase functions server
taskkill /F /IM "supabase.exe" /T 2>nul

rem Start Supabase functions server in the background
start /B supabase functions serve --no-verify-jwt

echo Waiting 5 seconds for server to start...
timeout /t 5 /nobreak > nul

echo Publishing gapi-list-domains task...
deno run -A ./taskcode/publish.ts --specific gapi-list-domains

echo Waiting 2 seconds...
timeout /t 2 /nobreak > nul

echo Running gapi-list-domains task...
deno run -A ./gapi-list-domains-cli.js

echo Done! 