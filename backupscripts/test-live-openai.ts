// Test the live WrappedOpenAI service
import { createServiceProxy } from 'npm:sdk-http-wrapper@1.0.10/client';
import { config } from "https://deno.land/x/dotenv/mod.ts";

// Load environment variables
const env = config();

const openai = createServiceProxy('openai', {
  baseUrl: `${env.SUPABASE_URL}/functions/v1/wrappedopenai`,
  headers: {
    'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
    'apikey': env.SUPABASE_ANON_KEY
  }
});

async function runTests() {
  try {
    // Test chat completion
    console.log('Testing chat completion:');
    const chatResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello!" }
      ],
      max_tokens: 50
    });
    console.log('Response:', chatResponse.choices[0].message.content);
    
    // Test embeddings
    console.log('\nTesting embeddings:');
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: 'The quick brown fox jumps over the lazy dog'
    });
    if (embeddingResponse?.data?.data?.[0]?.embedding) {
      console.log('Embedding length:', embeddingResponse.data.data[0].embedding.length);
      console.log('Sample values:', embeddingResponse.data.data[0].embedding.slice(0, 5));
    } else {
      console.error('Error: Unexpected embeddings response structure:', JSON.stringify(embeddingResponse, null, 2));
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

await runTests();
