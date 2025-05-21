// check-tables.ts
// Checks and updates database schema as needed

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Get Supabase URL and key from environment
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "http://localhost:54321";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

interface Column {
  column_name: string;
  [key: string]: any;
}

// Create Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function checkTaskRunsTable() {
  console.log("Checking task_runs table schema...");
  
  try {
    // Check if aggregated_results column exists
    const { data: columns, error } = await supabase.rpc("dbdev_get_columns", {
      p_table_name: "task_runs"
    });
    
    if (error) {
      console.error("Error checking columns:", error);
      
      // Alternative approach using direct SQL
      const { data: altColumns, error: altError } = await supabase.from("information_schema.columns")
        .select("column_name")
        .eq("table_name", "task_runs");
        
      if (altError) {
        console.error("Error with alternative check:", altError);
        console.log("Will attempt to add column anyway...");
      } else {
        console.log("Columns found:", altColumns);
        
        // Check if aggregated_results exists
        const hasColumn = altColumns.some((col: Column) => col.column_name === "aggregated_results");
        if (hasColumn) {
          console.log("aggregated_results column already exists");
          return;
        }
      }
    } else {
      console.log("Columns found:", columns);
      
      // Check if aggregated_results exists
      const hasColumn = columns.some((col: Column) => col.column_name === "aggregated_results");
      if (hasColumn) {
        console.log("aggregated_results column already exists");
        return;
      }
    }
    
    // Add the missing column
    console.log("Adding aggregated_results column to task_runs table...");
    const { error: alterError } = await supabase.rpc("dbdev_execute", {
      p_statement: "ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS aggregated_results JSONB"
    });
    
    if (alterError) {
      console.error("Error adding column with rpc:", alterError);
      
      // Try direct SQL as fallback
      const { error: sqlError } = await supabase.from("_sql").select("*").eq(
        "query", "ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS aggregated_results JSONB"
      );
      
      if (sqlError) {
        console.error("Error adding column with direct SQL:", sqlError);
        console.log("Failed to add aggregated_results column. Please add it manually.");
      } else {
        console.log("Successfully added aggregated_results column");
      }
    } else {
      console.log("Successfully added aggregated_results column");
    }
  } catch (error) {
    console.error("Unexpected error:", error);
  }
}

// Check stack_runs table for parent_stack_run_id column
async function checkStackRunsTable() {
  console.log("Checking stack_runs table schema...");
  
  try {
    // Check if parent_stack_run_id column exists
    const { data: columns, error } = await supabase.rpc("dbdev_get_columns", {
      p_table_name: "stack_runs"
    });
    
    if (error) {
      console.error("Error checking columns:", error);
      
      // Alternative approach using direct SQL
      const { data: altColumns, error: altError } = await supabase.from("information_schema.columns")
        .select("column_name")
        .eq("table_name", "stack_runs");
        
      if (altError) {
        console.error("Error with alternative check:", altError);
        console.log("Will attempt to add column anyway...");
      } else {
        console.log("Columns found:", altColumns);
        
        // Check if parent_stack_run_id exists
        const hasColumn = altColumns.some((col: Column) => col.column_name === "parent_stack_run_id");
        if (hasColumn) {
          console.log("parent_stack_run_id column already exists");
          return;
        }
      }
    } else {
      console.log("Columns found:", columns);
      
      // Check if parent_stack_run_id exists
      const hasColumn = columns.some((col: Column) => col.column_name === "parent_stack_run_id");
      if (hasColumn) {
        console.log("parent_stack_run_id column already exists");
        return;
      }
    }
    
    // Add the missing column
    console.log("Adding parent_stack_run_id column to stack_runs table...");
    const { error: alterError } = await supabase.rpc("dbdev_execute", {
      p_statement: "ALTER TABLE stack_runs ADD COLUMN IF NOT EXISTS parent_stack_run_id UUID"
    });
    
    if (alterError) {
      console.error("Error adding column with rpc:", alterError);
      
      // Try direct SQL as fallback
      const { error: sqlError } = await supabase.from("_sql").select("*").eq(
        "query", "ALTER TABLE stack_runs ADD COLUMN IF NOT EXISTS parent_stack_run_id UUID"
      );
      
      if (sqlError) {
        console.error("Error adding column with direct SQL:", sqlError);
        console.log("Failed to add parent_stack_run_id column. Please add it manually.");
      } else {
        console.log("Successfully added parent_stack_run_id column");
      }
    } else {
      console.log("Successfully added parent_stack_run_id column");
    }
  } catch (error) {
    console.error("Unexpected error:", error);
  }
}

async function main() {
  console.log("Checking and updating database schema...");
  
  // Check and update task_runs table
  await checkTaskRunsTable();
  
  // Check and update stack_runs table
  await checkStackRunsTable();
  
  console.log("Schema check complete");
}

// Run the script
main().catch(console.error); 