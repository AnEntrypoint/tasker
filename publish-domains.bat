@echo off
echo Setting environment variables for publishing tasks...

set SUPABASE_URL=http://localhost:54321
set SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU
set SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0

echo Running publish command for gapi-list-domains...
concurrently --kill-others "supabase functions serve --no-verify-jwt" "deno run -A ./taskcode/publish.ts --specific gapi-list-domains"
timeout /t 3

echo Running publish command for gapi-list-domains-with-nested...
concurrently --kill-others "supabase functions serve --no-verify-jwt" "deno run -A ./taskcode/publish.ts --specific gapi-list-domains-with-nested"

echo Done! 