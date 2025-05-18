#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

import { parse } from "https://deno.land/std@0.207.0/flags/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

/**
 * Format logs in a consistent way
 */
function log(level: string, message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  
  if (data) {
    console.log(logMessage, data);
  } else {
    console.log(logMessage);
  }
}

/**
 * List all available tasks in the database
 */
async function listTasks(): Promise<void> {
  log("info", "Listing available tasks...");
  
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  
  if (!supabaseUrl || !supabaseAnonKey) {
    log("error", "SUPABASE_URL and SUPABASE_ANON_KEY must be set in the environment.");
    Deno.exit(1);
  }
  
  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  
  try {
    const { data, error } = await supabase.from("task_functions").select("name, description");
    
    if (error) {
      log("error", "Failed to fetch tasks", error);
      Deno.exit(1);
    }
    
    if (!data || data.length === 0) {
      log("info", "No tasks found in the database.");
      return;
    }
    
    console.log("\nAvailable Tasks:");
    console.log("================");
    
    for (const task of data) {
      console.log(`- ${task.name}${task.description ? `: ${task.description}` : ""}`);
    }
    
    console.log("\n");
  } catch (error) {
    log("error", "Error fetching tasks", error);
    Deno.exit(1);
  }
}

/**
 * Execute a task with the given name and input
 */
async function executeTask(taskName: string, input: Record<string, unknown> = {}): Promise<void> {
  log("info", `Executing task: ${taskName}`, input);
  
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  
  if (!supabaseUrl || !supabaseAnonKey) {
    log("error", "SUPABASE_URL and SUPABASE_ANON_KEY must be set in the environment.");
    Deno.exit(1);
  }
  
  const tasksEndpoint = `${supabaseUrl}/functions/v1/tasks`;
  
  try {
    const response = await fetch(tasksEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseAnonKey}`
      },
      body: JSON.stringify({
        taskName,
        input
      })
    });
    
    const responseData = await response.json();
    
    if (!response.ok) {
      log("error", `Task execution failed (${response.status})`, responseData);
      Deno.exit(1);
    }
    
    log("info", "Task submitted successfully", responseData);
    
    // If the task is using ephemeral execution, we should have a task run ID
    if (responseData.taskRunId) {
      log("info", `Task run ID: ${responseData.taskRunId}`);
      log("info", "The task is running in the background.");
      log("info", "You can check the status and result in the task_runs table.");
      
      // Optionally poll for the result
      if (args.poll) {
        await pollTaskResult(responseData.taskRunId, supabaseUrl, supabaseAnonKey);
      }
    } else {
      log("info", "Task result:", responseData.result);
    }
  } catch (error) {
    log("error", "Error executing task", error);
    Deno.exit(1);
  }
}

/**
 * Poll the task_runs table for the result of a task
 */
async function pollTaskResult(taskRunId: string, supabaseUrl: string, supabaseAnonKey: string, maxAttempts = 30): Promise<void> {
  log("info", "Polling for task result...");
  
  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  let attempts = 0;
  
  const checkResult = async (): Promise<boolean> => {
    attempts++;
    log("info", `Checking task run status (attempt ${attempts}/${maxAttempts})...`);
    
    const { data, error } = await supabase
      .from("task_runs")
      .select("status, result, error")
      .eq("id", taskRunId)
      .single();
    
    if (error) {
      log("error", "Failed to check task status", error);
      return true; // Stop polling on error
    }
    
    if (!data) {
      log("error", "Task run not found");
      return true; // Stop polling if task run not found
    }
    
    log("info", `Task status: ${data.status}`);
    
    if (data.status === "complete") {
      log("info", "Task completed successfully");
      log("info", "Result:", data.result);
      return true; // Stop polling on completion
    } else if (data.status === "error") {
      log("error", "Task failed", data.error);
      return true; // Stop polling on error
    }
    
    return false; // Continue polling if not complete or error
  };
  
  // Initial check
  if (await checkResult()) {
    return;
  }
  
  // Poll for result
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between polls
    
    if (await checkResult()) {
      return;
    }
  }
  
  log("warn", `Polling timed out after ${maxAttempts} attempts`);
}

/**
 * Display help information
 */
function showHelp(): void {
  console.log(`
Tasker Task Executor
====================

A command-line tool for executing tasks in the Tasker system.

Usage:
  deno run --allow-net --allow-env --allow-read run-task.ts [options]

Options:
  --task, -t       Name of the task to execute
  --input, -i      Input parameters as JSON string
  --list, -l       List all available tasks
  --poll, -p       Poll for task completion and result
  --help, -h       Show this help information

Examples:
  deno run --allow-net --allow-env --allow-read run-task.ts --list
  deno run --allow-net --allow-env --allow-read run-task.ts --task module-diagnostic --input '{"checkGlobalScope":true}'
  deno run --allow-net --allow-env --allow-read run-task.ts --task gapi-list-domains-with-nested --poll
`);
}

/**
 * Main function
 */
async function main(): Promise<void> {
  const args = parse(Deno.args, {
    string: ["task", "input"],
    boolean: ["list", "poll", "help"],
    alias: {
      t: "task",
      i: "input",
      l: "list",
      p: "poll",
      h: "help"
    }
  });
  
  if (args.help) {
    showHelp();
    return;
  }
  
  if (args.list) {
    await listTasks();
    return;
  }
  
  if (args.task) {
    let input = {};
    
    if (args.input) {
      try {
        input = JSON.parse(args.input);
      } catch (error) {
        log("error", "Failed to parse input JSON", error);
        Deno.exit(1);
      }
    }
    
    await executeTask(args.task, input);
    return;
  }
  
  // If no valid command found, show help
  showHelp();
}

// Parse command-line arguments
const args = parse(Deno.args, {
  string: ["task", "input"],
  boolean: ["list", "poll", "help"],
  alias: {
    t: "task",
    i: "input",
    l: "list",
    p: "poll",
    h: "help"
  }
});

// Run the main function
await main(); 