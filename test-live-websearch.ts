  // Test the live WrappedWebsearch service
  import { createServiceProxy } from "npm:sdk-http-wrapper@1.0.10/client";
  import { config } from "https://deno.land/x/dotenv/mod.ts";
  const env = config();

  interface WebSearchResult {
    query: string;
    results: Array<{
      title: string;
      url: string;
      snippet: string;
    }>;
    timestamp: string;
  }

  const websearch = createServiceProxy<{
    search(query: string, maxResults?: number): Promise<WebSearchResult>;
    getServerTime(): { timestamp: string; source: string };
  }>('websearch', {
    baseUrl: `${env.SUPABASE_URL}/functions/v1/wrappedwebsearch`,
    headers: {
      'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
      'apikey': env.SUPABASE_ANON_KEY
    }
  });

  async function runTests() {
    console.log('Testing websearch service');
    
    const time = await websearch.getServerTime();
    console.log("Server time:", time);
    
    const results = await websearch.search("test query", 3);
    console.log("Search results:", results);
    
    const [result1, result2] = await Promise.all([
      websearch.search("concurrent test 1"),
      websearch.search("concurrent test 2")
    ]);
    console.log("Concurrent results:", { result1, result2 });
  }

  await runTests();