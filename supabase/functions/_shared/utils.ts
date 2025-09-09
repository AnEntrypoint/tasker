// supabase/functions/_shared/utils.ts

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Shared type definitions
export type LogEntry = {
	level: 'debug' | 'info' | 'warn' | 'error' | 'log',
	message: string,
	timestamp: string,
	data?: any
};

// Shared utility functions
export function simpleStringify(object: any): string {
	try {
		const seen = new WeakSet();
		return JSON.stringify(object, (key, value) => {
			if (typeof value === 'object' && value !== null) {
				if (seen.has(value)) {
					return '[Circular]';
				}
				seen.add(value);
			}
			return value;
		}, 2);
	} catch (e) {
		return `[Error stringifying object: ${e instanceof Error ? e.message : String(e)}]`;
	}
}

export function hostLog(
	prefix: string,
	level: LogEntry['level'],
	message: string,
	...additionalData: any[]
): void {
	// Format the prefix and level consistently
	const timestamp = new Date().toISOString();
	const formattedPrefix = prefix ? `[${prefix}]` : '';
	const formattedLevel = level.toUpperCase();
	
	// Only stringify additional data if not empty
	const dataString = additionalData.length > 0 
		? additionalData.map(data => 
			typeof data === 'string' ? data : simpleStringify(data)
		).join(' ')
		: '';

	// Create the log string
	const logString = `${timestamp} ${formattedPrefix} [${formattedLevel}] ${message} ${dataString}`.trim();
	
	// Use appropriate console method based on level
	switch (level) {
		case 'debug':
			console.debug(logString);
			break;
		case 'info':
			console.info(logString);
			break;
		case 'warn':
			console.warn(logString);
			break;
		case 'error':
			console.error(logString);
			break;
		default:
			console.log(logString);
	}
}

export async function fetchTaskFromDatabase(
	supabaseClient: SupabaseClient,
	taskIdOrName: string,
	taskId: string | null = null,
	log: (message: string) => void = console.log
): Promise<string | null> {
	try {
		let query = supabaseClient.from('task_functions').select('*');
		
		if (taskId && isUuid(taskId)) {
			query = query.eq('id', taskId);
			log(`Querying task by ID: ${taskId}`);
		} else {
			const searchTerm = taskIdOrName;
			query = query.eq('name', searchTerm);
			log(`Querying task by name: ${searchTerm}`);
		}
		
		const { data, error } = await query.limit(1).single();
		
		if (error) {
			log(`Task lookup failed: ${error.message}`);
			return null;
		}
		
		if (!data) {
			log(`No task found for ${taskIdOrName}`);
			return null;
		}
		
		log(`Task found: ${data.name} (id: ${data.id})`);
		return data.code;
	} catch (error) {
		log(`Database fetch error: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

export function isUuid(str: string): boolean {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(str);
}

export function createErrorResponse(
	message: string, 
	statusCode: number = 500, 
	details?: any
): Response {
	return new Response(
		JSON.stringify({
			error: message,
			details: details,
			timestamp: new Date().toISOString()
		}),
		{
			status: statusCode,
			headers: {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization'
			}
		}
	);
}

export function createSuccessResponse(
	data: any, 
	statusCode: number = 200
): Response {
	return new Response(
		JSON.stringify({
			data,
			timestamp: new Date().toISOString()
		}),
		{
			status: statusCode,
			headers: {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization'
			}
		}
	);
}

export function getServiceRoleClient(): SupabaseClient {
	const supabaseUrl = Deno.env.get('SUPABASE_URL');
	const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
	
	if (!supabaseUrl || !supabaseServiceKey) {
		throw new Error('Missing Supabase configuration (URL or Service Role Key)');
	}
	
	return createClient(supabaseUrl, supabaseServiceKey, {
		auth: { persistSession: false }
	});
} 