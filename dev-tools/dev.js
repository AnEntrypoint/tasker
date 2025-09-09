#!/usr/bin/env node

/**
 * Development Tools Wrapper
 * 
 * Simple wrapper script for common development tasks.
 * Usage: node dev-tools/dev.js <command> [args...]
 */

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const COMMANDS = {
  'dev': {
    script: 'function-dev-server.js',
    description: 'Start function development server with hot reload'
  },
  'test': {
    script: 'function-tester.js', 
    description: 'Test individual functions with payloads'
  },
  'debug': {
    script: 'function-debugger.js',
    description: 'Debug and monitor functions'
  }
};

function showHelp() {
  console.log(`
Development Tools Wrapper

Usage: node dev-tools/dev.js <command> [args...]

Commands:
${Object.entries(COMMANDS).map(([cmd, info]) => `  ${cmd.padEnd(8)} ${info.description}`).join('\n')}

Examples:
  node dev-tools/dev.js dev --function wrappedgapi
  node dev-tools/dev.js test --function wrappedgapi --test echo
  node dev-tools/dev.js debug --action database

For command-specific help:
  node dev-tools/dev.js <command> --help
`);
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }
  
  const command = args[0];
  const commandArgs = args.slice(1);
  
  if (!COMMANDS[command]) {
    console.error(`❌ Unknown command: ${command}`);
    console.error('Available commands:', Object.keys(COMMANDS).join(', '));
    process.exit(1);
  }
  
  const scriptPath = join(__dirname, COMMANDS[command].script);
  
  // Spawn the appropriate script
  const child = spawn('node', [scriptPath, ...commandArgs], {
    stdio: 'inherit',
    cwd: process.cwd()
  });
  
  child.on('close', (code) => {
    process.exit(code);
  });
  
  child.on('error', (error) => {
    console.error('❌ Failed to run command:', error.message);
    process.exit(1);
  });
}

// Run main function if this file is executed directly
main();
