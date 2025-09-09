#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env

import * as path from "https://deno.land/std@0.201.0/path/mod.ts";
import * as fs from "https://deno.land/std@0.201.0/fs/mod.ts";
import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";
import { load } from "https://deno.land/std@0.201.0/dotenv/mod.ts";

// Load environment variables from .env file
await load({ export: true });

type Task = {
  name: string;
  description?: string;
  code: string;
};

const args = {
  all: Deno.args.includes("--all"),
  specific: Deno.args.includes("--specific"),
  list: Deno.args.includes("--list"),
  getSpecificTasks: () => {
    const index = Deno.args.indexOf("--specific");
    if (index === -1) return [];
    return Deno.args.slice(index + 1).filter(arg => !arg.startsWith("--"));
  }
};

// Simple logger
const logger = {
  info: (message: string) => console.log(`[INFO] ${message}`),
  error: (message: string, error?: Error) => {
    console.error(`[ERROR] ${message}`);
    if (error?.stack) console.error(error.stack);
  }
};

// Simple config
const CONFIG = {
  SUPABASE_URL: "http://localhost:54321", // Use correct Supabase port
  SUPABASE_SERVICE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("EXT_SUPABASE_SERVICE_ROLE_KEY") || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZn7aDF4JDgTy2WgGdVHUV9lbzN8sM2FvSzs",
  TASK_DIRS: [
    Deno.env.get("TASKS_DIRECTORY") ? `${Deno.env.get("TASKS_DIRECTORY")}/endpoints/` : "./endpoints/"
  ]
};

function createSupabaseClient() {
  const supabaseUrl = CONFIG.SUPABASE_URL;
  const supabaseServiceKey = CONFIG.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl) throw new Error("SUPABASE_URL environment variable is required");
  if (!supabaseServiceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY environment variable is required");

  logger.info("Creating Supabase client with service role...");

  return createServiceProxy('supabase', {
    baseUrl: `${supabaseUrl}/functions/v1/wrappedsupabase`,
    headers: {
      'Authorization': `Bearer ${supabaseServiceKey}`,
      'apikey': supabaseServiceKey
    }
  });
}

function extractDescription(fileContent: string, taskName = ""): string {
  const jsdocMatch = fileContent.match(/\/\*\*[\s\S]*?\*\//);
  if (jsdocMatch) {
    const rawDescription = jsdocMatch[0].replace(/\/\*\*|\*\//g, "");
    const description = rawDescription
      .split("\n")
      .map((line: string) => line.trim().replace(/^\s*\*\s*/, ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    return description;
  }
  return taskName ? `Task: ${taskName}` : "Task function";
}

async function discoverTasks(): Promise<string[]> {
  const taskFiles: string[] = [];
  const specificTasks = args.getSpecificTasks();

  if (args.specific && specificTasks.length > 0) {
    logger.info(`Looking for specific tasks: ${specificTasks.join(", ")}`);
    for (const dir of CONFIG.TASK_DIRS) {
      if (await fs.exists(dir)) {
        for (const taskName of specificTasks) {
          const jsFilePath = path.join(dir, `${taskName}.js`);
          if (await fs.exists(jsFilePath)) {
            taskFiles.push(jsFilePath);
          }
        }
      }
    }
  } else {
    for (const dir of CONFIG.TASK_DIRS) {
      if (await fs.exists(dir)) {
        for await (const entry of Deno.readDir(dir)) {
          if (entry.isFile && entry.name.endsWith(".js")) {
            taskFiles.push(path.join(dir, entry.name));
          }
        }
      }
    }
  }

  logger.info(`Discovered ${taskFiles.length} task files`);
  return taskFiles;
}

async function publishTask(client: any, filePath: string): Promise<boolean> {
  const fileContent = await Deno.readTextFile(filePath);
  const fileName = path.basename(filePath);
  const taskName = fileName.replace(/\.js$/, "");
  const description = extractDescription(fileContent, taskName);

  logger.info(`Publishing task: ${taskName}`);
  
  const payload = {
    name: taskName,
    code: fileContent,
    description: description
  };

  const result = await client.from('task_functions')
    .upsert([payload], { onConflict: 'name' });

  if (result?.error) {
    throw new Error(`Error upserting task: ${result.error.message}`);
  }

  logger.info(`Task ${taskName} published successfully`);
  return true;
}

async function listTasks(): Promise<Task[]> {
  logger.info("Listing tasks...");
  const client = createSupabaseClient();

  const result = await client.from('task_functions')
    .select('name, description')
    .order('name', { ascending: true });

  if (result.error) {
    throw new Error(`Error fetching tasks: ${result.error.message}`);
  }

  const tasks = result.data || [];

  if (!tasks || tasks.length === 0) {
    logger.info("No tasks found in the database");
  } else {
    logger.info(`Found ${tasks.length} tasks in the database:`);
    for (const task of tasks) {
      const description = task.description?.split("\n")[0]?.substring(0, 50) || "No description";
      console.log(`- ${task.name}\n  ${description}...`);
    }
  }

  return tasks;
}

async function main() {
  try {
    logger.info("Waiting for 3 seconds before starting...");
    await new Promise(resolve => setTimeout(resolve, 3000)); // Add 3-second delay

    if (args.list) {
      await listTasks();
      return;
    }

    const client = createSupabaseClient();
    const taskFiles = await discoverTasks();

    if (taskFiles.length === 0) {
      logger.info("No task files found. Nothing to publish.");
      return;
    }

    let publishedCount = 0;
    for (const filePath of taskFiles) {
      try {
        await publishTask(client, filePath);
        publishedCount++;
      } catch (error) {
        logger.error(`Failed to publish ${filePath}: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error : undefined);
      }
    }

    logger.info(`Published ${publishedCount} of ${taskFiles.length} tasks successfully`);
    
    if (publishedCount < taskFiles.length) {
      throw new Error(`Failed to publish ${taskFiles.length - publishedCount} tasks`);
    }
  } catch (error) {
    logger.error(`Task publishing failed: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error : undefined);
    Deno.exit(1);
  }
}

main();
