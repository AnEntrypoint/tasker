import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = 'http://127.0.0.1:54321';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const client = createClient(supabaseUrl, supabaseKey);

console.log('Checking for comprehensive-gmail-search task...');
const { data, error } = await client
  .from('task_functions')
  .select('*')
  .eq('name', 'comprehensive-gmail-search');

if (error) {
  console.error('Error:', error);
} else {
  console.log('Found tasks:', data?.length || 0);
  if (data && data.length > 0) {
    console.log('Task details:', {
      id: data[0].id,
      name: data[0].name,
      description: data[0].description,
      hasCode: !!data[0].code,
      codeLength: data[0].code?.length || 0
    });
  }
}