#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

// Task publisher script for Tasker
// This script discovers and publishes task functions to the Supabase database

import { parse as parseArgs } from "https://deno.land/std/flags/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { join, basename } from "https://deno.land/std/path/mod.ts";
import { walk } from "https://deno.land/std/fs/mod.ts";

// Parse command line arguments
const args = parseArgs(Deno.args, {
  boolean: ["all", "list"],
  string: ["specific"],
  default: { all: false, list: false, specific: "" },
});

// Get Supabase credentials
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "http://localhost:54321";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Error: SUPABASE_SERVICE_ROLE_KEY environment variable is required");
  Deno.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Define types for task metadata
type TaskParameter = {
  name: string;
  type: string;
  description: string;
  required: boolean;
};

type TaskReturn = {
  type: string;
  description: string;
};

type TaskMetadata = {
  name: string;
  description: string;
  parameters: TaskParameter[];
  returns: TaskReturn;
};

type Task = {
  name: string;
  description: string;
  code: string;
  schema: Record<string, unknown>;
  file_path: string;
  parameters: TaskParameter[];
  returns: TaskReturn;
};

/**
 * Extract JSDoc comments and metadata from task code
 * @param code The task code content
 * @returns Parsed task metadata
 */
function parseTaskMetadata(code: string): TaskMetadata {
  // Find JSDoc comments
  const jsdocRegex = /\/\*\*\s*([\s\S]*?)\s*\*\//g;
  const jsdocMatches = code.match(jsdocRegex);
  
  if (!jsdocMatches || jsdocMatches.length === 0) {
    throw new Error("No JSDoc comments found in task code");
  }
  
  const jsdocContent = jsdocMatches[0];
  
  // Extract task name from @task tag
  const taskNameMatch = /@task\s+([a-zA-Z0-9_-]+)/.exec(jsdocContent);
  const taskName = taskNameMatch ? taskNameMatch[1] : null;
  
  if (!taskName) {
    throw new Error("Task name not found in JSDoc @task tag");
  }
  
  // Extract description from @description tag
  const descriptionMatch = /@description\s+(.*?)(?=\s*@|\s*\*\/)/.exec(jsdocContent);
  const description = descriptionMatch ? descriptionMatch[1].trim() : "";
  
  // Extract parameters from @param tags
  const paramRegex = /@param\s+\{([^}]+)\}\s+(\[?[a-zA-Z0-9_.]+\]?)\s*-?\s*(.*?)(?=\s*@|\s*\*\/)/g;
  let paramMatch;
  const params: TaskParameter[] = [];
  
  while ((paramMatch = paramRegex.exec(jsdocContent)) !== null) {
    const type = paramMatch[1].trim();
    const name = paramMatch[2].trim().replace(/^\[|\]$/g, ""); // Remove brackets from optional params
    const description = paramMatch[3].trim();
    const isOptional = paramMatch[2].includes("[");
    
    params.push({
      name,
      type,
      description,
      required: !isOptional,
    });
  }
  
  // Extract return type from @returns tag
  const returnsMatch = /@returns\s+\{([^}]+)\}\s*(.*?)(?=\s*@|\s*\*\/)/.exec(jsdocContent);
  const returnType = returnsMatch ? returnsMatch[1].trim() : "any";
  const returnDescription = returnsMatch ? returnsMatch[2].trim() : "";
  
  return {
    name: taskName,
    description,
    parameters: params,
    returns: {
      type: returnType,
      description: returnDescription,
    },
  };
}

/**
 * Generate a JSON Schema for task parameters
 * @param taskMetadata Parsed task metadata
 * @returns JSON Schema object
 */
function generateJsonSchema(taskMetadata: TaskMetadata): Record<string, unknown> {
  const schema = {
    type: "object",
    required: [] as string[],
    properties: {} as Record<string, unknown>,
    additionalProperties: false,
  };
  
  for (const param of taskMetadata.parameters) {
    let paramSchema: Record<string, unknown> = {};
    
    // Convert JSDoc type to JSON Schema type
    switch (param.type.toLowerCase()) {
      case "string":
        paramSchema.type = "string";
        break;
      case "number":
        paramSchema.type = "number";
        break;
      case "boolean":
        paramSchema.type = "boolean";
        break;
      case "array":
        paramSchema.type = "array";
        break;
      case "object":
        paramSchema.type = "object";
        break;
      default:
        if (param.type.startsWith("Array<")) {
          paramSchema.type = "array";
        } else if (param.type.includes("|")) {
          paramSchema.type = param.type.split("|").map((t: string) => t.trim().toLowerCase());
        } else {
          paramSchema.type = "object";
        }
    }
    
    // Add description and required flag
    paramSchema.description = param.description;
    
    // Add the parameter to the schema
    schema.properties[param.name] = paramSchema;
    
    // Add to required list if necessary
    if (param.required) {
      schema.required.push(param.name);
    }
  }
  
  return schema;
}

/**
 * Find task files in the taskcode/endpoints directory
 * @returns Array of task file paths
 */
async function findTaskFiles(): Promise<string[]> {
  const endpointsDir = join(Deno.cwd(), "taskcode", "endpoints");
  const files: string[] = [];
  
  for await (const entry of walk(endpointsDir, { exts: [".js"] })) {
    if (entry.isFile) {
      files.push(entry.path);
    }
  }
  
  return files;
}

/**
 * Read a task file and extract its code and metadata
 * @param filePath Path to the task file
 * @returns Task object with code and metadata
 */
async function readTaskFile(filePath: string): Promise<Task> {
  const code = await Deno.readTextFile(filePath);
  const metadata = parseTaskMetadata(code);
  const schema = generateJsonSchema(metadata);
  
  return {
    name: metadata.name,
    description: metadata.description,
    code,
    schema,
    file_path: filePath,
    parameters: metadata.parameters,
    returns: metadata.returns,
  };
}

/**
 * Publish a task to the Supabase database
 * @param task Task object with code and metadata
 * @returns Result of the database operation
 */
async function publishTask(task: Task): Promise<{ action: string; name: string }> {
  console.log(`Publishing task: ${task.name}`);
  
  // Check if task already exists
  const { data: existingTask, error: selectError } = await supabase
    .from("task_functions")
    .select("id")
    .eq("name", task.name)
    .maybeSingle();
  
  if (selectError) {
    throw new Error(`Error checking if task exists: ${selectError.message}`);
  }
  
  // Update or insert the task
  if (existingTask) {
    console.log(`Updating existing task: ${task.name}`);
    
    const { error: updateError } = await supabase
      .from("task_functions")
      .update({
        description: task.description,
        code: task.code,
        schema: task.schema,
        file_path: task.file_path,
        updated_at: new Date().toISOString(),
      })
      .eq("name", task.name);
    
    if (updateError) {
      throw new Error(`Error updating task: ${updateError.message}`);
    }
    
    return { action: "updated", name: task.name };
  } else {
    console.log(`Creating new task: ${task.name}`);
    
    const { error: insertError } = await supabase
      .from("task_functions")
      .insert({
        name: task.name,
        description: task.description,
        code: task.code,
        schema: task.schema,
        file_path: task.file_path,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    
    if (insertError) {
      throw new Error(`Error inserting task: ${insertError.message}`);
    }
    
    return { action: "created", name: task.name };
  }
}

/**
 * List all tasks in the database
 */
async function listTasks(): Promise<void> {
  console.log("Listing tasks in the database...");
  
  const { data: tasks, error } = await supabase
    .from("task_functions")
    .select("id, name, description, created_at, updated_at");
  
  if (error) {
    throw new Error(`Error listing tasks: ${error.message}`);
  }

  if (!tasks || tasks.length === 0) {
    console.log("No tasks found in the database.");
    return;
  }
  
  console.log(`Found ${tasks.length} tasks:`);
  console.log("------------------------------------------------------");
  console.log("| ID | Name | Description | Created | Updated |");
  console.log("------------------------------------------------------");
  
    for (const task of tasks) {
    const created = new Date(task.created_at).toISOString().split("T")[0];
    const updated = new Date(task.updated_at).toISOString().split("T")[0];
    console.log(`| ${task.id} | ${task.name} | ${task.description.substring(0, 30)}... | ${created} | ${updated} |`);
  }
  
  console.log("------------------------------------------------------");
}

/**
 * Main function to run the publish script
 */
async function main(): Promise<void> {
  try {
    console.log("Tasker Task Publisher");
    console.log("=====================");
    
    // Handle --list flag
    if (args.list) {
      await listTasks();
      Deno.exit(0);
    }

    // Find task files
    const taskFiles = await findTaskFiles();
    console.log(`Found ${taskFiles.length} task files in taskcode/endpoints/`);

    if (taskFiles.length === 0) {
      console.log("No task files found.");
      Deno.exit(0);
    }
    
    // Handle --specific flag
    if (args.specific) {
      const specificTaskName = args.specific;
      console.log(`Publishing specific task: ${specificTaskName}`);
      
      const matchingFile = taskFiles.find(file => {
        const fileName = basename(file, ".js");
        return fileName === specificTaskName;
      });
      
      if (!matchingFile) {
        console.error(`Error: Task file for '${specificTaskName}' not found.`);
        Deno.exit(1);
      }
      
      const task = await readTaskFile(matchingFile);
      const result = await publishTask(task);
      console.log(`Task ${result.name} ${result.action} successfully.`);
      Deno.exit(0);
    }
    
    // Handle --all flag
    if (args.all) {
      console.log("Publishing all tasks...");
      
      const results: { action: string; name: string }[] = [];
      
      for (const file of taskFiles) {
        try {
          const task = await readTaskFile(file);
          const result = await publishTask(task);
          results.push(result);
          console.log(`Task ${result.name} ${result.action} successfully.`);
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`Error processing ${file}: ${errorMessage}`);
        }
      }
      
      console.log(`Published ${results.length} tasks successfully.`);
      Deno.exit(0);
    }
    
    // If no flags are specified, show usage information
    console.log("Usage:");
    console.log("  --all        Publish all tasks");
    console.log("  --specific   Publish a specific task by name");
    console.log("  --list       List all tasks in the database");
    console.log("");
    console.log("Examples:");
    console.log("  deno run --allow-net --allow-env --allow-read taskcode/publish.ts --all");
    console.log("  deno run --allow-net --allow-env --allow-read taskcode/publish.ts --specific module-diagnostic");
    console.log("  deno run --allow-net --allow-env --allow-read taskcode/publish.ts --list");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${errorMessage}`);
    Deno.exit(1);
  }
}

// Run the main function
await main();
