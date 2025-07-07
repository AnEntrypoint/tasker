// supabase/functions/stack-processor/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.201.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { 
    processStackRunViaQuickJs, 
    ProcessStackRunParams, 
    ProcessStackRunResult 
} from '../tasks/handlers/task-executor.ts';
import { corsHeaders } from "../quickjs/cors.ts";
import { hostLog, simpleStringify } from '../_shared/utils.ts';

const LOG_PREFIX = "[StackProcessorEF]";

// --- Environment Setup ---
let INTERNAL_SUPABASE_REST_URL = Deno.env.get('SUPABASE_URL') || Deno.env.get('EXT_SUPABASE_URL') || 'http://127.0.0.1:8000';
console.warn(`${LOG_PREFIX} INTERNAL_SUPABASE_REST_URL set to: ${INTERNAL_SUPABASE_REST_URL}`);

const SERVICE_ROLE_KEY = Deno.env.get('EXT_SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

if (!SERVICE_ROLE_KEY) {
    console.error(`${LOG_PREFIX} CRITICAL: Service role key (EXT_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY) is not configured.`);
    throw new Error("Stack Processor: Missing Supabase service role key.");
}
if (!INTERNAL_SUPABASE_REST_URL) {
    console.error(`${LOG_PREFIX} CRITICAL: Internal Supabase URL (SUPABASE_URL or default) is not configured.`);
    throw new Error("Stack Processor: Missing internal Supabase URL.");
}

console.log(`${LOG_PREFIX} INTERNAL_SUPABASE_REST_URL: ${INTERNAL_SUPABASE_REST_URL}`);
console.log(`${LOG_PREFIX} SERVICE_ROLE_KEY (masked): ${SERVICE_ROLE_KEY ? '********' : 'MISSING'}`);

const adminSupabaseClient: SupabaseClient = createClient(INTERNAL_SUPABASE_REST_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});

async function handleRequest(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    let stackRunIdToProcess: string | null = null;
    let claimedRunDetailsForErrorHandling: { id: string, parent_task_run_id: string | null } | null = null;

    try {
        // Try to get stackRunId from request body (e.g., direct trigger)
        if (req.body) {
            try {
                const body = await req.json();
                if (body && typeof body.stackRunId === 'string') {
                    stackRunIdToProcess = body.stackRunId;
                    hostLog(LOG_PREFIX, 'info', `Received direct request to process stackRunId: ${stackRunIdToProcess}`);
                }
            } catch (e) {
                // Not a JSON body or no stackRunId, proceed to fetch next pending.
                hostLog(LOG_PREFIX, 'debug', `No valid JSON body with stackRunId, or not a direct invocation: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        // If not provided, try to find the next pending stack run
        if (!stackRunIdToProcess) {
            hostLog(LOG_PREFIX, 'info', "No specific stackRunId provided, attempting to fetch next pending run.");
            const { data: nextPending, error: fetchError } = await adminSupabaseClient
                .from('stack_runs')
                .select('id')
                .eq('status', 'pending')
                .order('created_at', { ascending: true })
                .limit(1)
                .maybeSingle();

            if (fetchError) {
                hostLog(LOG_PREFIX, 'error', "Error fetching next pending stack run:", fetchError.message);
                return new Response(simpleStringify({ error: "Failed to fetch next pending task", details: fetchError.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }

            if (nextPending && nextPending.id) {
                stackRunIdToProcess = nextPending.id;
                hostLog(LOG_PREFIX, 'info', `Found pending stack run to process: ${stackRunIdToProcess}`);
            } else {
                hostLog(LOG_PREFIX, 'info', "No pending stack runs found at this time.");
                return new Response(simpleStringify({ message: "No pending stack runs to process." }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
        }
        
        if (!stackRunIdToProcess) { // Should be caught by the "No pending" case above
            hostLog(LOG_PREFIX, 'warn', "Stack run ID to process could not be determined.");
            return new Response(simpleStringify({ error: "Could not determine stack run to process." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        claimedRunDetailsForErrorHandling = { id: stackRunIdToProcess, parent_task_run_id: null };


        // --- Mark the chosen stack_run as 'processing' to prevent race conditions ---
        const { data: claimedRun, error: claimError } = await adminSupabaseClient
            .from('stack_runs')
            .update({ status: 'processing', updated_at: new Date().toISOString() })
            .eq('id', stackRunIdToProcess)
            .eq('status', 'pending') 
            .select('id, parent_task_run_id, service_name, method_name, args, vm_state, parent_stack_run_id')
            .single();

        if (claimError || !claimedRun) {
            hostLog(LOG_PREFIX, 'warn', `Failed to claim stack run ${stackRunIdToProcess} or it was not pending: ${claimError?.message || 'Claim failed or run not found/not pending'}`);
            return new Response(simpleStringify({ message: `Stack run ${stackRunIdToProcess} could not be claimed. It might be processed by another instance or already completed/not pending.` }), 
                { status: claimError?.code === 'PGRST116' ? 404 : 200 , headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        claimedRunDetailsForErrorHandling = { id: claimedRun.id, parent_task_run_id: claimedRun.parent_task_run_id };
        hostLog(LOG_PREFIX, 'info', `Successfully claimed stack_run: ${claimedRun.id} for processing.`);

        // --- Main Processing Logic ---
        const { parent_task_run_id, vm_state, parent_stack_run_id: parentStackRunId } = claimedRun;

        if (!vm_state || typeof vm_state !== 'object') {
             throw new Error(`Stack run ${claimedRun.id} has invalid or missing vm_state.`);
        }
        
        type ExpectedVmState = { taskCode: string; taskName: string; taskInput?: Record<string, unknown>; [key: string]: any; };
        const typedVmState = vm_state as ExpectedVmState;

        if (!typedVmState.taskCode || !typedVmState.taskName) {
            throw new Error(`Stack run ${claimedRun.id} vm_state is missing essential taskCode or taskName.`);
        }
        if (!parent_task_run_id) { // Every stack run should be associated with an original task_run
            throw new Error(`Stack run ${claimedRun.id} is missing parent_task_run_id.`);
        }

        const qjsParams: ProcessStackRunParams = {
            taskCode: typedVmState.taskCode,
            taskName: typedVmState.taskName,
            taskInput: typedVmState.taskInput || {},
            parentTaskRunId: parent_task_run_id, 
            currentStackRunId: claimedRun.id,
            dbClient: adminSupabaseClient
        };

        hostLog(LOG_PREFIX, 'info', `[stackRun:${claimedRun.id}] Calling processStackRunViaQuickJs for task '${typedVmState.taskName}'.`);
        const qjsResult: ProcessStackRunResult = await processStackRunViaQuickJs(qjsParams);
        hostLog(LOG_PREFIX, 'info', `[stackRun:${claimedRun.id}] processStackRunViaQuickJs returned status: ${qjsResult.status}`);

        // --- Handle QuickJS Outcome ---
        if (qjsResult.status === 'completed') {
            if (parentStackRunId) { // This stack_run was a child/nested call that completed
                hostLog(LOG_PREFIX, 'info', `[stackRun:${claimedRun.id}] Child completed. Resuming parent stack_run: ${parentStackRunId} with result.`);
                
                // Fetch the parent stack_run to update its vm_state
                const { data: parentStackRunToResume, error: fetchParentError } = await adminSupabaseClient
                    .from('stack_runs')
                    .select('vm_state')
                    .eq('id', parentStackRunId)
                    .eq('status', 'suspended') // Parent should be suspended
                    .single();

                if (fetchParentError || !parentStackRunToResume) {
                    hostLog(LOG_PREFIX, 'error', `[stackRun:${claimedRun.id}] Failed to fetch suspended parent stack_run ${parentStackRunId}: ${fetchParentError?.message || 'Not found'}. Cannot resume.`);
                    // This is an orphaned flow, might need manual intervention or a cleanup process.
                    // For now, we'll fail the main task_run.
                    await adminSupabaseClient.from('task_runs').update({
                        status: 'failed',
                        error: { message: `Failed to resume parent stack_run ${parentStackRunId} after child ${claimedRun.id} completed. Parent not found or not suspended.`, qjsResultError: qjsResult.error },
                        updated_at: new Date().toISOString(),
                        ended_at: new Date().toISOString()
                    }).eq('id', parent_task_run_id);

                } else {
                    const parentVmState = (parentStackRunToResume.vm_state || {}) as ExpectedVmState;
                    parentVmState.last_call_result = qjsResult.result; // Store result for resumption

                    const { error: resumeError } = await adminSupabaseClient
                        .from('stack_runs')
                        .update({
                            status: 'pending', // Ready for next processing cycle to resume
                            vm_state: parentVmState, 
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', parentStackRunId);

                    if (resumeError) {
                        hostLog(LOG_PREFIX, 'error', `[stackRun:${claimedRun.id}] Failed to update and set parent stack_run ${parentStackRunId} to pending: ${resumeError.message}.`);
                        await adminSupabaseClient.from('task_runs').update({
                            status: 'failed',
                            error: { message: `Failed to set parent stack_run ${parentStackRunId} to pending for resumption.`, details: resumeError.message },
                            updated_at: new Date().toISOString(),
                            ended_at: new Date().toISOString()
                        }).eq('id', parent_task_run_id);
                    } else {
                        hostLog(LOG_PREFIX, 'info', `[stackRun:${claimedRun.id}] Parent stack_run ${parentStackRunId} updated with result and set to pending.`);
                        triggerSelf({ stackRunId: parentStackRunId }); // Trigger processing for the now pending parent.
                    }
                }
            } else { // This was a top-level segment for the parent_task_run_id or the final result.
                hostLog(LOG_PREFIX, 'info', `[stackRun:${claimedRun.id}] Top-level segment completed. Updating parent task_run: ${parent_task_run_id}`);
                const { error: taskRunUpdateError } = await adminSupabaseClient
                    .from('task_runs')
                    .update({
                        status: 'completed',
                        result: qjsResult.result,
                        updated_at: new Date().toISOString(),
                        ended_at: new Date().toISOString()
                    })
                    .eq('id', parent_task_run_id);

                if (taskRunUpdateError) {
                    hostLog(LOG_PREFIX, 'error', `[stackRun:${claimedRun.id}] Failed to update parent task_run ${parent_task_run_id} to completed: ${taskRunUpdateError.message}`);
                } else {
                     hostLog(LOG_PREFIX, 'info', `[stackRun:${claimedRun.id}] Parent task_run ${parent_task_run_id} marked as completed.`);
                }
            }
        } else if (qjsResult.status === 'failed') {
            // processStackRunViaQuickJs already updated the current stack_run to 'failed'.
            hostLog(LOG_PREFIX, 'error', `[stackRun:${claimedRun.id}] Processing failed. Failing parent task_run: ${parent_task_run_id}`);
            const { error: taskRunUpdateError } = await adminSupabaseClient
                .from('task_runs')
                .update({
                    status: 'failed', 
                    error: qjsResult.error || { message: "A segment of the task failed.", failedStackRunId: claimedRun.id, qjsRawResponse: qjsResult.qjsRawResponse },
                    updated_at: new Date().toISOString(),
                    ended_at: new Date().toISOString()
                })
                .eq('id', parent_task_run_id);
            if (taskRunUpdateError) {
                hostLog(LOG_PREFIX, 'error', `[stackRun:${claimedRun.id}] Failed to update parent task_run ${parent_task_run_id} to failed state: ${taskRunUpdateError.message}`);
            } else {
                 hostLog(LOG_PREFIX, 'info', `[stackRun:${claimedRun.id}] Parent task_run ${parent_task_run_id} marked as failed.`);
            }
            // If this failed stack_run had a parentStackRunId, that parent is now orphaned in 'suspended' state.
            // This indicates a programming error in the QJS task or a deeper issue.
            // For now, the main task_run is failed, which is the primary outcome.
             if (parentStackRunId) {
                hostLog(LOG_PREFIX, 'warn', `[stackRun:${claimedRun.id}] Child failed, but it had a parentStackRunId ${parentStackRunId}. This parent stack_run is now effectively orphaned in a suspended state.`);
                 await adminSupabaseClient.from('stack_runs').update({
                    status: 'failed', // Mark the suspended parent as failed too
                    error: { message: `Child stack_run ${claimedRun.id} failed, orphaning this suspended parent.`, childError: qjsResult.error },
                    updated_at: new Date().toISOString(),
                    ended_at: new Date().toISOString()
                }).eq('id', parentStackRunId);
            }

        } else if (qjsResult.status === 'suspended') {
            // QuickJS suspended. processStackRunViaQuickJs assumes QuickJS:
            // 1. Updated the current stack_run (claimedRun.id) to 'suspended'.
            // 2. Created a new child stack_run with 'pending' status for the host call.
            hostLog(LOG_PREFIX, 'info', `[stackRun:${claimedRun.id}] Suspended by QuickJS. A new child stack_run is expected to be 'pending'.`);
            // The self-trigger at the end will pick up the new 'pending' child.
        }

        hostLog(LOG_PREFIX, 'info', `[stackRun:${claimedRun.id}] Processing complete for this iteration. Attempting to trigger processing for next pending task (if any).`);
        
        // ALWAYS use HTTP trigger to ensure fresh worker process
        // This is critical for suspend/resume memory management
        triggerSelf({});

        return new Response(simpleStringify({
            message: `Processed stack run ${claimedRun.id}. Final status of this segment: ${qjsResult.status}.`,
            stackRunId: claimedRun.id,
            outcome_status: qjsResult.status
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        const currentProcessingId = claimedRunDetailsForErrorHandling?.id || "unknown_id_at_error_catch";
        const currentParentTaskRunId = claimedRunDetailsForErrorHandling?.parent_task_run_id;

        hostLog(LOG_PREFIX, 'error', `[stackRun:${currentProcessingId}] CRITICAL error during stack run processing: ${error.message}`, error.stack);
        
        try { // Fail the current stack_run if it wasn't the source of the error already (e.g. QJS call failed)
            await adminSupabaseClient
                .from('stack_runs')
                .update({ 
                    status: 'failed', 
                    error: { message: "Stack processor unhandled internal error", details: error.message, stack: error.stack?.toString() },
                    updated_at: new Date().toISOString(),
                    ended_at: new Date().toISOString()
                })
                .eq('id', currentProcessingId); 
        } catch (dbUpdateError) {
            hostLog(LOG_PREFIX, 'error', `[stackRun:${currentProcessingId}] Additionally failed to mark stack_run (${currentProcessingId}) as failed on CRITICAL catch: ${dbUpdateError}`);
        }

        if (currentParentTaskRunId) { // Fail the main task_run
            try {
                 await adminSupabaseClient
                    .from('task_runs')
                    .update({ 
                        status: 'failed', 
                        error: { message: "Task processing failed due to stack processor critical error", details: error.message, failedStackRunId: currentProcessingId },
                        updated_at: new Date().toISOString(),
                        ended_at: new Date().toISOString()
                     })
                    .eq('id', currentParentTaskRunId);
            } catch (parentUpdateError) {
                hostLog(LOG_PREFIX, 'error', `[stackRun:${currentProcessingId}] Additionally failed to mark parent task_run (${currentParentTaskRunId}) as failed on CRITICAL catch: ${parentUpdateError}`);
            }
        }
        
        // In local dev, try to process next pending run
        const isLocalDev = INTERNAL_SUPABASE_REST_URL.includes('127.0.0.1') || INTERNAL_SUPABASE_REST_URL.includes('localhost');
        if (!isLocalDev) {
            triggerSelf({}); // Attempt to process next to prevent system stall if possible.
        }

        return new Response(simpleStringify({ error: "Failed to process stack run due to critical internal error.", details: error.message, processedStackRunId: currentProcessingId }), 
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
}

function triggerSelf(payload: { stackRunId?: string }): void {
    let triggerUrlBase = Deno.env.get('EXT_SUPABASE_URL');
    if (!triggerUrlBase) {
        triggerUrlBase = Deno.env.get('SUPABASE_URL'); 
        hostLog(LOG_PREFIX, 'warn', `EXT_SUPABASE_URL not found for self-trigger, using SUPABASE_URL: ${triggerUrlBase}. This might not be externally routable for self-invocation.`);
    }
    
    if (!triggerUrlBase) {
        hostLog(LOG_PREFIX, 'error', "Cannot self-trigger stack processor: EXT_SUPABASE_URL and SUPABASE_URL are undefined.");
        return;
    }
    
    const fullTriggerUrlBase = triggerUrlBase.startsWith('http') ? triggerUrlBase : `http://${triggerUrlBase}`;
    
    // For local development, use kong URL for edge-to-edge communication
    const selfTriggerUrl = (fullTriggerUrlBase.includes('127.0.0.1') || fullTriggerUrlBase.includes('localhost'))
        ? 'http://kong:8000/functions/v1/stack-processor'
        : `${fullTriggerUrlBase}/functions/v1/stack-processor`;

    hostLog(LOG_PREFIX, 'info', `Asynchronously self-triggering stack-processor for stackRunId: '${payload.stackRunId || 'next pending'}' at ${selfTriggerUrl}`);

    fetch(selfTriggerUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}` // Stack processor is an internal admin function.
        },
        body: JSON.stringify(payload)
    }).then(async res => {
        if (!res.ok) {
            const errorBody = await res.text();
            hostLog(LOG_PREFIX, 'warn', `Self-trigger POST to stack-processor failed: ${res.status} - ${errorBody}`);
        } else {
            hostLog(LOG_PREFIX, 'info', `Self-trigger POST to stack-processor for '${payload.stackRunId || 'next pending'}' potentially successful.`);
        }
    }).catch(e => {
        const error = e instanceof Error ? e : new Error(String(e));
        hostLog(LOG_PREFIX, 'error', `Error during self-trigger fetch for stack-processor: ${error.message}`);
    });
}

serve(handleRequest);

hostLog(LOG_PREFIX, "Stack Processor Edge Function server started."); 