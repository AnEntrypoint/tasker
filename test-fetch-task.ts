import { fetchTaskFromDatabase } from './supabase/functions/tasks/services/database.ts';

console.log('Testing fetchTaskFromDatabase...');
const result = await fetchTaskFromDatabase('comprehensive-gmail-search');
console.log('Result:', result);