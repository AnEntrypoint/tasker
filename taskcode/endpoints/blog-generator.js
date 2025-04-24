/**
 * Generates a blog post about a given topic using web search results and OpenAI
 *
 * @param {Object} input
 * @param {string} input.topic - Topic for the blog post
 * @param {number} [input.searchResults=3] - Number of web search results to include
 * @param {string} [input.model="gpt-4o-mini"] - OpenAI model to use
 * @param {number} [input.temperature=0.7] - Temperature for OpenAI generation
 * @param {number} [input.maxTokens=1500] - Maximum tokens for OpenAI response
 * @returns {Promise<Object>} Blog post content and sources
 */
module.exports = async function({ topic, searchResults = 3, model = "gpt-4o-mini", temperature = 0.7, maxTokens = 1500 }) {
  // Validate input parameters
  if (!topic || typeof topic !== 'string') {
    throw new Error('A valid topic string is required');
  }

  console.log(`Generating blog post about: "${topic}"`);
  console.log(`Using parameters: searchResults=${searchResults}, model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);

  let searchData = [];
  let searchContext = '';

  try {
    // Perform web search
    console.log(`Searching for information about: "${topic}"`);
    const searchResponse = await tools.websearch.search({
      query: topic,
      limit: searchResults
    });

    if (!searchResponse || !searchResponse.results || !Array.isArray(searchResponse.results)) {
      console.warn('Web search returned invalid or empty results, proceeding with empty context');
    } else {
      searchData = searchResponse.results;
      console.log(`Found ${searchData.length} search results`);

      // Format search results as context
      searchContext = searchData.map((result, i) =>
        `Source ${i + 1}: ${result.title || 'Untitled'}\nURL: ${result.url || 'No URL'}\nSummary: ${result.snippet || 'No snippet'}\n\n`
      ).join("");

      console.log(`Search context formatted (${searchContext.length} characters)`);
    }
  } catch (searchError) {
    console.error(`Web search error: ${searchError.message || searchError}`);
    // Continue without search results rather than failing completely
    searchContext = `Unable to retrieve search results for "${topic}". Generating content from model knowledge only.\n\n`;
  }

  console.log("=== WEB SEARCH COMPLETED SUCCESSFULLY ===");
  console.log("=== PREPARING TO CALL OPENAI API ===");

  try {
    // Generate blog post with OpenAI
    console.log(`Generating blog content using model: ${model}`);
    console.log(`Temperature: ${temperature}, Max tokens: ${maxTokens}`);

    console.log('=== STARTING OPENAI API CALL ===');
    console.log('Using tools.openai.chat.completions.create()');

    // Prepare the messages
    const messages = [
      { role: "system", content: "You are a professional blog writer. Create a well-structured, informative blog post with an introduction, main sections, and conclusion." },
      { role: "user", content: `Write a comprehensive blog post about: "${topic}"\n\n${searchContext ? `Here is some research to incorporate:\n\n${searchContext}\n\n` : ''}` }
    ];
    console.log(`Prepared ${messages.length} messages for OpenAI`);

    // Limit max_tokens to ensure faster response (optional, but good practice for testing)
    const limitedMaxTokens = Math.min(maxTokens, 500);
    console.log(`Using limited max_tokens: ${limitedMaxTokens} (original: ${maxTokens})`);

    // Make the API call
    console.log('Calling OpenAI API...');
    const openaiResponse = await tools.openai.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens: limitedMaxTokens
    });
    console.log('=== OPENAI API CALL COMPLETED ===');

    // Validate OpenAI response
    console.log('=== VALIDATING OPENAI RESPONSE ===');
    if (!openaiResponse) {
      console.error('OpenAI response is null or undefined');
      throw new Error('OpenAI returned a null or undefined response');
    }

    if (!openaiResponse.choices) {
      console.error('OpenAI response has no choices array', openaiResponse);
      throw new Error('OpenAI response has no choices array');
    }

    if (!openaiResponse.choices[0]) {
      console.error('OpenAI response has empty choices array', openaiResponse.choices);
      throw new Error('OpenAI response has empty choices array');
    }

    if (!openaiResponse.choices[0].message) {
      console.error('OpenAI response has no message in first choice', openaiResponse.choices[0]);
      throw new Error('OpenAI response has no message in first choice');
    }

    console.log('OpenAI response validation successful');
    const content = openaiResponse.choices[0].message.content;
    console.log(`Successfully generated blog post (${content.length} characters)`);

    console.log('=== PREPARING FINAL RESPONSE ===');
    // Prepare sources
    const sources = searchData.map(result => ({
      title: result.title || 'Untitled',
      url: result.url || 'No URL'
    }));
    console.log(`Prepared ${sources.length} sources`);

    // Prepare metadata
    const metadata = {
      topic,
      modelUsed: model,
      generatedAt: new Date().toISOString(),
      searchResultsCount: searchData.length
    };
    console.log('Prepared metadata');

    // Return the final result
    console.log('=== RETURNING FINAL RESULT ===');
    return {
      content,
      sources,
      metadata
    };
  } catch (openaiError) {
    console.log('=== ERROR DURING OPENAI GENERATION ===');
    console.error(`OpenAI generation error: ${openaiError.message || openaiError}`);

    // Log the error stack if available
    if (openaiError.stack) {
      console.error(`Error stack: ${openaiError.stack}`);
    }

    // Log additional error details if available
    if (openaiError.code) {
      console.error(`Error code: ${openaiError.code}`);
    }

    if (openaiError.type) {
      console.error(`Error type: ${openaiError.type}`);
    }

    console.log('=== THROWING ERROR ===');
    throw new Error(`Failed to generate blog content: ${openaiError.message || 'Unknown error'}`);
  }
};