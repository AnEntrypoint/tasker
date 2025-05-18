/**
 * Sample task for Tasker system that demonstrates how to use the tools object
 * 
 * @param {object} input - Input parameters
 * @param {string} input.query - Search query to use
 * @param {string} [input.model="gpt-3.5-turbo"] - OpenAI model to use
 * @returns {object} - Task output with generated content
 */
export async function runTask(input, tools) {
  tools.log('info', 'Starting sample task', input);
  
  // Input validation
  if (!input.query) {
    tools.log('error', 'Missing required parameter: query');
    throw new Error('Missing required parameter: query');
  }
  
  // Use websearch to get relevant information
  tools.log('info', 'Searching for information');
  const searchResults = await tools.websearch.search(input.query);
  tools.log('info', `Found ${searchResults.length} search results`);
  
  // Format search results for OpenAI
  let context = 'Search Results:\n\n';
  searchResults.forEach((result, index) => {
    context += `Source ${index + 1}: ${result.title}\n`;
    context += `URL: ${result.url}\n`;
    context += `Snippet: ${result.snippet}\n\n`;
  });
  
  // Use OpenAI to generate content
  tools.log('info', 'Generating content with OpenAI');
  const openaiResponse = await tools.openai.chat.completions.create({
    model: input.model || 'gpt-3.5-turbo',
    messages: [
      {
        role: 'system',
        content: 'You are a helpful assistant that creates concise summaries. Use the search results to answer the query but be brief and factual.'
      },
      {
        role: 'user',
        content: `Query: ${input.query}\n\n${context}`
      }
    ],
    temperature: 0.3,
    max_tokens: 500
  });
  
  // Extract the generated content
  const generatedContent = openaiResponse.choices[0].message.content;
  tools.log('info', 'Content generated successfully');
  
  // Save the result to the database
  tools.log('info', 'Saving result to database');
  await tools.supabase.from('task_results').insert({
    query: input.query,
    generated_content: generatedContent,
    created_at: new Date().toISOString()
  });
  
  // Return the final result
  return {
    query: input.query,
    generated_content: generatedContent,
    search_results: searchResults.map(r => ({ title: r.title, url: r.url })),
    timestamp: new Date().toISOString()
  };
} 