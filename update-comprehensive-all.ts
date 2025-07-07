#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env

// Direct update script for comprehensive-gmail-search-all task
const SUPABASE_URL = "http://127.0.0.1:8000";
const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

console.log("Reading task file...");
const taskCode = await Deno.readTextFile("taskcode/endpoints/comprehensive-gmail-search-all.js");

console.log("Updating comprehensive-gmail-search-all in Supabase...");
const response = await fetch(`${SUPABASE_URL}/rest/v1/task_functions?name=eq.comprehensive-gmail-search-all`, {
  method: 'PATCH',
  headers: {
    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    'apikey': SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  },
  body: JSON.stringify({
    code: taskCode,
    description: 'Comprehensive Gmail Search - ALL users and ALL emails with full pagination',
    updated_at: new Date().toISOString()
  })
});

if (!response.ok) {
  const errorText = await response.text();
  console.error(`Failed to update: ${response.status} ${errorText}`);
  Deno.exit(1);
}

const result = await response.json();
console.log("✅ Task updated successfully!", result);