import { SupabaseClient, createClient } from 'npm:@supabase/supabase-js';

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Error: SUPABASE_URL and SUPABASE_ANON_KEY environment variables are required.");
  Deno.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function runNestedTaskCaller(topic) {
  console.log(`Calling nested-task-caller with topic: "${topic}"`);
  try {
    const { data, error } = await supabase.functions.invoke("tasks", {
      body: {
        taskName: "nested-task-caller",
        input: { topic: topic },
      },
    });

    if (error) {
      console.error("Error invoking Supabase function:", error);
      return;
    }

    console.log("------- Nested Task Caller Result -------");
    // The result from 'nested-task-caller' should directly be the result of 'blog-generator'
    if (data?.success && data?.result) {
         console.log("Blog Content:\n", data.result.blogContent);
         console.log("\nSources:\n", data.result.sources);
         console.log("\nMetadata:\n", data.result.metadata);
    } else {
         console.log("Raw Response Data:", JSON.stringify(data, null, 2));
    }
     console.log("\n------- Logs -------");
     if(data?.logs && Array.isArray(data.logs)) {
         data.logs.forEach(log => console.log(`[${log.timestamp}] [${log.level.toUpperCase()}] ${log.source ? '['+log.source+'] ' : ''}${log.message}${log.data ? ' ' + JSON.stringify(log.data) : ''}`));
     } else {
        console.log("No logs available or logs format incorrect.");
     }
     console.log("--------------------");


  } catch (err) {
    console.error("Error during task execution:", err);
  }
}

const topicArg = Deno.args[0];
if (!topicArg) {
  console.error("Usage: deno run -A nested-task-caller-cli.js <topic>");
  Deno.exit(1);
}

runNestedTaskCaller(topicArg); 