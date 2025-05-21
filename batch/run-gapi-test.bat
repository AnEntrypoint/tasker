@echo off
echo === GAPI Sleep/Resume Test ===
echo.

set TEST_TYPE=%1
if "%TEST_TYPE%"=="" set TEST_TYPE=echo

echo Starting test with type: %TEST_TYPE%
echo.

echo Starting Supabase Functions...
start "Supabase Functions" /MIN cmd /c supabase functions serve --no-verify-jwt

echo Giving functions time to start...
timeout /t 3 > nul

echo Running GAPI test...
deno run -A tests/gapi/test-gapi-sleep-resume-direct.ts %TEST_TYPE%

echo Test complete! 