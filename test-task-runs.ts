import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "https://deno.land/x/dotenv@v3.2.2/load.ts";

// Basic logging
const log = (level: string, message: string, data?: any) => {
  console.log(`[${level.toUpperCase()}] ${message}`, data !== undefined ? JSON.stringify(data, null, 2) : "");
};

async function runTest() {
  log("info", "Starting test-task-runs script...");

  // --- Config --- 
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const functionsUrl = `${supabaseUrl}/functions/v1`;
  const quickjsUrl = `${functionsUrl}/quickjs`;

  if (!supabaseUrl || !supabaseAnonKey) {
    log("error", "SUPABASE_URL and SUPABASE_ANON_KEY must be set in the environment.");
    Deno.exit(1);
  }

  // --- Create Supabase Client (Anon Key) --- 
  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  // --- Fetch 'parent' Task Code --- 
  log("info", "Fetching 'parent' task code from database...");
  const { data: taskData, error: fetchError } = await supabase
    .from('task_functions')
    .select('code')
    .eq('name', 'parent')
    .single();

  if (fetchError || !taskData || !taskData.code) {
    log("error", "Failed to fetch 'parent' task code", fetchError || "Task not found");
    Deno.exit(1);
  }
  const parentTaskCode = taskData.code;
  log("info", "Successfully fetched 'parent' task code.");

  // --- Prepare QuickJS Payload --- 
  const taskName = "parent";
  const input = { message: "Testing task runs logging" };
  
  // Define service proxies needed by the task (and the nested task)
  // The 'parent' task calls tools.tasks.execute('echo', ...)
  // The 'echo' task doesn't call any tools.
  // So, we primarily need the 'tasks' proxy which points back to quickjs itself?
  // Or does tools.tasks.execute resolve to the host __callHostTool__ which then calls the appropriate proxy?
  // Let's assume __callHostTool__ handles routing based on tool name.
  // We need proxies for any service the *host* might call via __callHostTool__.
  // In this case, the nested call is 'tasks.execute', so the host needs a proxy for 'tasks'.
  const serviceProxies = [
    {
      name: "tasks", 
      baseUrl: quickjsUrl, // Pointing back to the quickjs function itself for nested tasks
      headers: { Authorization: `Bearer ${supabaseAnonKey}` } // Pass auth if needed by function
    },
    // Add other proxies (openai, keystore etc.) if the task needed them
  ];

  const runtimeConfig = {
    supabaseUrl: supabaseUrl,
    supabaseAnonKey: supabaseAnonKey,
    // stackRunId: null // No parent for this top-level call
  };

  const payload = {
    taskName: taskName,
    code: parentTaskCode,
    input: input,
    serviceProxies: serviceProxies,
    runtimeConfig: runtimeConfig
  };

  log("info", "Sending request to QuickJS function...", { url: quickjsUrl });
  // log("debug", "Payload:", payload); // Optional: log full payload

  // --- Call QuickJS Function --- 
  try {
    const response = await fetch(quickjsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseAnonKey}` // Use anon key for initial call
      },
      body: JSON.stringify(payload),
    });

    log("info", `QuickJS Response Status: ${response.status} ${response.statusText}`);
    const responseBody = await response.json();
    log("info", "QuickJS Response Body:", responseBody);

    if (!response.ok) {
      log("error", "QuickJS function call failed.");
    } else {
      log("info", "QuickJS function call successful.");
      // Optional: Add checks here based on expected result structure
      if (responseBody.success === true && responseBody.result?.parentCompleted === true) {
         log("info", "Task execution appears successful based on result.");
      } else {
         log("warn", "Task execution result might indicate an issue.", responseBody);
      }
    }

  } catch (error) {
    log("error", "Error calling QuickJS function", error);
  }
  log("info", "test-task-runs script finished.");
}

runTest(); 