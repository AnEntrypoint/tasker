@echo off
REM Create logs directory if it doesn't exist
if not exist logs mkdir logs

echo Running all diagnostic tools to identify Tasker system health...

echo.
echo 1. Testing database connection...
deno run -A diagnostics/test-db-connection.ts > logs\db-connection.log
timeout /t 2 > nul

echo.
echo 2. Checking database triggers...
deno run -A diagnostics/check-and-fix-trigger.ts > logs\trigger-check.log
timeout /t 2 > nul

echo.
echo 3. Testing stack processor...
deno run -A diagnostics/check-stack-processor-trigger.ts > logs\stack-processor.log
timeout /t 2 > nul

echo.
echo 4. Running stuck task detection...
deno run -A diagnostics/detect-stuck-tasks.ts > logs\stuck-task.log
timeout /t 2 > nul

echo.
echo 5. Performing VM state diagnostics...
deno run -A diagnostics/diagnose-vm-state.ts > logs\vm-state.log
timeout /t 2 > nul

echo.
echo 6. Testing with non-polling approach...
deno run -A tests/gapi/test-gapi-no-polling.ts > logs\no-polling-test.log
timeout /t 2 > nul

echo.
echo 7. Running comprehensive diagnostics...
deno run -A diagnostics/comprehensive-task-diagnostic.ts > logs\comprehensive.log

echo.
echo All diagnostic tests complete! See logs directory for results.
echo. 