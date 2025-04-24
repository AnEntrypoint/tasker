/**
 * WebSearch service implementation
 */


// Web search service implementation
export default {
  search: async (queryOrOptions: string | any, optionsOrLimit?: number | any) => {
    // Parse query and options
    const query = typeof queryOrOptions === 'string' 
      ? queryOrOptions 
      : (queryOrOptions?.query || queryOrOptions?.q || '');
    
    const maxResults = typeof optionsOrLimit === 'number' 
      ? optionsOrLimit 
      : (typeof optionsOrLimit === 'object' ? optionsOrLimit?.maxResults : null) 
      || (typeof queryOrOptions === 'object' ? queryOrOptions?.limit || queryOrOptions?.maxResults : null) 
      || 3;
    
    if (!query) {
      console.error('[ERROR] [search] Search query is required');
      throw new Error("Search query is required");
    }
    
    // Perform search
    console.info(`[INFO] [search] Performing DuckDuckGo search: ${query} (maxResults: ${maxResults})`);
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    
    try {
      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html'
        }
      });
      
      if (!response.ok) {
        console.error(`[ERROR] [search] DuckDuckGo request failed: ${response.status} ${response.statusText}`);
        throw new Error(`DuckDuckGo request failed: ${response.status} ${response.statusText}`);
      }
      
      const html = await response.text();
      console.info(`[INFO] [search] Received HTML response, extracting results`);
      
      // Extract results
      const titleUrlRegex = /<h2 class="result__title">[\s\S]*?<a rel="nofollow" class="result__a" href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/g;
      const snippetRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      
      const titles: Array<{url: string, title: string}> = [];
      const snippets: string[] = [];
      let match;
      
      while ((match = titleUrlRegex.exec(html)) !== null) {
        const url = match[1].trim();
        const title = match[2].replace(/<[^>]*>/g, '').trim();
        if (url && title) titles.push({ url, title });
      }
      
      while ((match = snippetRegex.exec(html)) !== null) {
        snippets.push(match[1].replace(/<[^>]*>/g, '').trim());
      }
      
      // Combine results
      const results = [];
      const limit = Math.min(titles.length, snippets.length, maxResults);
      
      for (let i = 0; i < limit; i++) {
        results.push({
          title: titles[i].title,
          url: titles[i].url,
          snippet: snippets[i] || titles[i].title
        });
      }
      
      console.info(`[INFO] [search] Found ${results.length} results for query: ${query}`);
      return { query, results, timestamp: new Date().toISOString() };
    } catch (error) {
      console.error(`[ERROR] [search] ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  },
  
  getServerTime: () => {
    console.info('[INFO] [getServerTime] Getting server time');
    return { timestamp: new Date().toISOString(), source: "websearch" };
  }
}; 