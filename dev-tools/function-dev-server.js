#!/usr/bin/env node

/**
 * Edge Function Development Server
 * 
 * Runs individual Supabase Edge Functions with hot reload for rapid development.
 * Usage: npm run dev:function -- --function wrappedgapi --port 8001
 */

import { spawn } from 'child_process';
import { watch } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const SUPABASE_FUNCTIONS_DIR = join(__dirname, '..', 'supabase', 'functions');
const DEFAULT_PORT = 8001;

// Available edge functions
const AVAILABLE_FUNCTIONS = [
  'wrappedgapi',
  'wrappedkeystore', 
  'wrappedsupabase',
  'wrappedopenai',
  'wrappedwebsearch',
  'quickjs',
  'stack-processor',
  'tasks',
  'admin-debug'
];

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }
  
  const options = {
    functionName: null,
    port: DEFAULT_PORT,
    watch: true,
    verbose: false
  };
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--function' && args[i + 1]) {
      options.functionName = args[i + 1];
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      options.port = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--no-watch') {
      options.watch = false;
    } else if (args[i] === '--verbose') {
      options.verbose = true;
    }
  }
  
  return options;
}

function showHelp() {
  console.log(`
Edge Function Development Server

Usage: npm run dev:function -- [options]

Options:
  --function <name>    Function to run (required)
  --port <number>      Port to run on (default: ${DEFAULT_PORT})
  --no-watch          Disable file watching
  --verbose           Enable verbose logging
  --help, -h          Show this help

Available functions:
  ${AVAILABLE_FUNCTIONS.map(f => `  ${f}`).join('\n')}

Examples:
  npm run dev:function -- --function wrappedgapi
  npm run dev:function -- --function wrappedgapi --port 8002
  npm run dev:function -- --function quickjs --verbose
`);
}

// Function development server class
class FunctionDevServer {
  constructor(functionName, port, options = {}) {
    this.functionName = functionName;
    this.port = port;
    this.options = options;
    this.functionDir = join(SUPABASE_FUNCTIONS_DIR, functionName);
    this.process = null;
    this.isRestarting = false;
  }

  async start() {
    console.log(`🚀 Starting development server for function: ${this.functionName}`);
    console.log(`📁 Function directory: ${this.functionDir}`);
    console.log(`🌐 Server will run on: http://localhost:${this.port}`);
    
    // Start the function
    await this.startFunction();
    
    // Setup file watching if enabled
    if (this.options.watch) {
      this.setupFileWatcher();
    }
    
    // Setup graceful shutdown
    this.setupShutdownHandlers();
    
    console.log(`✅ Development server ready!`);
    console.log(`📝 Make changes to files in ${this.functionDir} to trigger hot reload`);
  }

  async startFunction() {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        SUPABASE_URL: process.env.SUPABASE_URL || 'http://127.0.0.1:54321',
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || 
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
        PORT: this.port.toString()
      };

      // Use deno to run the function directly with serve
      this.process = spawn('deno', [
        'run',
        '--allow-all',
        '--watch',
        '--port', this.port.toString(),
        'index.ts'
      ], {
        cwd: this.functionDir,
        env: {
          ...env,
          DENO_SERVE_PORT: this.port.toString()
        },
        stdio: 'pipe'
      });

      this.process.stdout.on('data', (data) => {
        const output = data.toString();
        if (this.options.verbose || output.includes('Listening on')) {
          console.log(`[${this.functionName}] ${output.trim()}`);
        }
        
        // Resolve when server is ready
        if (output.includes('Listening on') && !this.isRestarting) {
          resolve();
        }
      });

      this.process.stderr.on('data', (data) => {
        console.error(`[${this.functionName}] ERROR: ${data.toString().trim()}`);
      });

      this.process.on('close', (code) => {
        if (code !== 0 && !this.isRestarting) {
          console.error(`[${this.functionName}] Process exited with code ${code}`);
          reject(new Error(`Function process exited with code ${code}`));
        }
      });

      this.process.on('error', (error) => {
        console.error(`[${this.functionName}] Failed to start process:`, error);
        reject(error);
      });
    });
  }

  setupFileWatcher() {
    console.log(`👀 Watching for changes in ${this.functionDir}`);
    
    const watcher = watch(this.functionDir, { recursive: true }, (eventType, filename) => {
      if (filename && (filename.endsWith('.ts') || filename.endsWith('.js'))) {
        console.log(`📝 File changed: ${filename}`);
        this.restart();
      }
    });

    // Also watch shared directory
    const sharedDir = join(SUPABASE_FUNCTIONS_DIR, '_shared');
    const sharedWatcher = watch(sharedDir, { recursive: true }, (eventType, filename) => {
      if (filename && (filename.endsWith('.ts') || filename.endsWith('.js'))) {
        console.log(`📝 Shared file changed: ${filename}`);
        this.restart();
      }
    });
  }

  async restart() {
    if (this.isRestarting) return;
    
    this.isRestarting = true;
    console.log(`🔄 Restarting ${this.functionName}...`);
    
    // Kill existing process
    if (this.process) {
      this.process.kill();
      await new Promise(resolve => {
        this.process.on('close', resolve);
      });
    }
    
    // Start new process
    try {
      await this.startFunction();
      console.log(`✅ ${this.functionName} restarted successfully`);
    } catch (error) {
      console.error(`❌ Failed to restart ${this.functionName}:`, error.message);
    }
    
    this.isRestarting = false;
  }

  setupShutdownHandlers() {
    const shutdown = () => {
      console.log(`\n🛑 Shutting down ${this.functionName} development server...`);
      if (this.process) {
        this.process.kill();
      }
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

// Main execution
async function main() {
  const options = parseArgs();
  
  if (!options.functionName) {
    console.error('❌ Function name is required. Use --function <name>');
    console.error('Available functions:', AVAILABLE_FUNCTIONS.join(', '));
    process.exit(1);
  }
  
  if (!AVAILABLE_FUNCTIONS.includes(options.functionName)) {
    console.error(`❌ Unknown function: ${options.functionName}`);
    console.error('Available functions:', AVAILABLE_FUNCTIONS.join(', '));
    process.exit(1);
  }
  
  const server = new FunctionDevServer(options.functionName, options.port, {
    watch: options.watch,
    verbose: options.verbose
  });
  
  try {
    await server.start();
  } catch (error) {
    console.error('❌ Failed to start development server:', error.message);
    process.exit(1);
  }
}

// Run main function if this file is executed directly
main().catch(console.error);
