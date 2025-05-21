#!/usr/bin/env deno run --allow-read --allow-env --allow-net
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";
import * as path from "https://deno.land/std@0.170.0/path/mod.ts";

// Load environment variables
config({ export: true });

const SUPABASE_URL = Deno.env.get("EXT_SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("EXT_SUPABASE_SERVICE_ROLE_KEY") || "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing required environment variables: EXT_SUPABASE_URL, EXT_SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function publishTask(taskPath: string, taskName: string) {
  console.log(`Publishing task: ${taskName}`);
  
  try {
    // Read the task file
    const taskCode = await Deno.readTextFile(taskPath);
    
    // Check if the task already exists
    const { data: existingTask, error: fetchError } = await supabase
      .from("task_functions")
      .select("*")
      .eq("name", taskName)
      .single();
    
    if (fetchError && fetchError.code !== "PGRST116") {
      console.error(`Error checking if task exists: ${fetchError.message}`);
      return false;
    }
    
    if (existingTask) {
      // Update existing task
      console.log(`Task '${taskName}' already exists, updating...`);
      const { error: updateError } = await supabase
        .from("task_functions")
        .update({
          code: taskCode,
          updated_at: new Date().toISOString()
        })
        .eq("name", taskName);
      
      if (updateError) {
        console.error(`Error updating task: ${updateError.message}`);
        return false;
      }
      
      console.log(`Task '${taskName}' updated successfully`);
    } else {
      // Create new task
      console.log(`Creating new task: ${taskName}`);
      const { error: insertError } = await supabase
        .from("task_functions")
        .insert({
          name: taskName,
          description: "Example of proper promise handling in QuickJS",
          code: taskCode,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      
      if (insertError) {
        console.error(`Error creating task: ${insertError.message}`);
        return false;
      }
      
      console.log(`Task '${taskName}' created successfully`);
    }
    
    return true;
  } catch (error: unknown) {
    console.error(`Error publishing task: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function main() {
  // Path to the example task
  const taskPath = "./taskcode/examples/promise-handling-example.js";
  const taskName = "promise-handling-example";
  
  // Publish the task
  const success = await publishTask(taskPath, taskName);
  
  if (success) {
    console.log("Task published successfully!");
  } else {
    console.error("Failed to publish task");
    Deno.exit(1);
  }
}

// Run the main function
if (import.meta.main) {
  main();
} 