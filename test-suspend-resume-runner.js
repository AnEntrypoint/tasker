// Script to run both server and client concurrently
const { execSync } = require('child_process');
const concurrently = require('concurrently');

console.log('Starting test for suspend-resume functionality...');

// Run concurrently with --kill-others flag
try {
  const { result } = concurrently([
    { 
      command: 'supabase functions serve --no-verify-jwt quickjs wrappedwebsearch',
      name: 'server',
      prefixColor: 'blue'
    },
    { 
      command: 'deno run --allow-net --allow-env --allow-read test-suspend-resume-minimal.ts',
      name: 'client',
      prefixColor: 'green'
    }
  ], {
    prefix: 'name',
    killOthers: ['failure', 'success'], // Kill other processes if one exits
    restartTries: 0, // Don't restart processes
    timestampFormat: 'HH:mm:ss'
  });

  // Wait for all processes to complete
  Promise.all(result).then(
    () => {
      console.log('All processes completed successfully');
      process.exit(0);
    },
    (error) => {
      console.error('Error in one of the processes:', error);
      process.exit(1);
    }
  );
} catch (error) {
  console.error('Failed to start processes:', error);
  process.exit(1);
} 