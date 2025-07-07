#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env

// Direct publish script for comprehensive-gmail-search-all task
const SUPABASE_URL = "http://127.0.0.1:8000";
const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

console.log("Reading task file...");
const taskCode = await Deno.readTextFile("taskcode/endpoints/comprehensive-gmail-search-all.js");

console.log("Publishing comprehensive-gmail-search-all to Supabase...");
const response = await fetch(`${SUPABASE_URL}/functions/v1/wrappedsupabase/from/task_functions/upsert`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    'apikey': SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    records: [{
      name: 'comprehensive-gmail-search-all',
      code: taskCode,
      description: 'Comprehensive Gmail Search - ALL users and ALL emails with full pagination'
    }],
    options: { onConflict: 'name' }
  })
});

if (!response.ok) {
  const errorText = await response.text();
  console.error(`Failed to publish: ${response.status} ${errorText}`);
  Deno.exit(1);
}

const result = await response.json();
console.log("✅ Task published successfully!", result);