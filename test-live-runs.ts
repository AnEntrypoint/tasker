// Test the live Runs service via service wrapper
import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";
import { config } from "https://deno.land/x/dotenv/mod.ts";
const env = config();

interface QueueResult {
  runId: number;
}

const runs = createServiceProxy<{
  queue(taskName: string, args?: Record<string, any>): Promise<QueueResult>;
}>("runs", {
  baseUrl: `${env.SUPABASE_URL}/functions/v1/runs`,
  headers: {
    'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
    'apikey': env.SUPABASE_ANON_KEY
  }
});

async function runTests() {
  console.log('Testing runs service');

  // Test queuing a task
  const result = await runs.queue("test_task", { foo: "bar", n: 42 });
  console.log("Queued run:", result);

  // Test queuing with alternate arg style
  const result2 = await runs.queue("another_task", { input: { x: 1 } });
  console.log("Queued run (alt):", result2);

  // Test error: missing name
  try {
    await runs.queue("");
  } catch (e: any) {
    console.log("Expected error (missing name):", e.message || e);
  }
}

await runTests(); 