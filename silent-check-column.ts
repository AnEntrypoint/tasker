import { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts';

// Silent check of the waiting_on_stack_run_id column in stack_runs table
// This script will only output minimal information

try {
  const pool = new Pool({
    user: 'postgres',
    password: 'postgres',
    database: 'postgres',
    hostname: 'localhost',
    port: 5432,
  }, 3);

  const client = await pool.connect();
  
  try {
    // Check if column exists
    const checkResult = await client.queryArray(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'stack_runs'
          AND column_name = 'waiting_on_stack_run_id'
          AND table_schema = 'public'
      );
    `);
    
    const columnExists = checkResult.rows[0][0];
    
    if (columnExists) {
      console.log("✅ Column waiting_on_stack_run_id exists in stack_runs table");
    } else {
      console.log("❌ Column waiting_on_stack_run_id doesn't exist, adding it now...");
      
      // Add the column
      await client.queryArray(`
        ALTER TABLE stack_runs 
        ADD COLUMN IF NOT EXISTS waiting_on_stack_run_id UUID REFERENCES stack_runs(id);
      `);
      
      console.log("✅ Column added successfully");
    }
  } finally {
    client.release();
  }
  
  await pool.end();
} catch (err) {
  // Only log minimal error information, not the full HTML
  console.error("Error checking/adding column:", err.message?.split("\n")[0] || "Unknown error");
} 