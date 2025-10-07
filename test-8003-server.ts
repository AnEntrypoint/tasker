import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

console.log("Simple server starting on port 8003...");

serve(() => new Response("Hello from port 8003"), { port: 8003 });