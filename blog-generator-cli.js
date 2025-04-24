#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config();

// Support remote override via EXT_* env vars
const {
  SUPABASE_URL: _SUP_URL,
  SUPABASE_ANON_KEY: _SUP_KEY,
  EXT_SUPABASE_URL,
  EXT_SUPABASE_ANON_KEY
} = process.env;
// Prefer external (remote) values over local emulator values
const SUPABASE_URL = EXT_SUPABASE_URL || _SUP_URL;
const SUPABASE_ANON_KEY = EXT_SUPABASE_ANON_KEY || _SUP_KEY;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  await sleep(3000); // Add 3-second delay
  try {

    console.log(`Using SUPABASE_URL: ${SUPABASE_URL}`);
    console.log(`Using SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY ? '***REDACTED***' : 'undefined'}`);
    const response = await fetch(`${SUPABASE_URL}/functions/v1/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ name: 'blog-generator', input: { topic: process.argv[2] } })
    });
    
      const text = await response.text();
      try {
        console.log(JSON.parse(text, null, 2));
        console.log(JSON.parse(text, null, 2).output);
      } catch {
        console.error('Non-JSON response:', text);
      }
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
})();
