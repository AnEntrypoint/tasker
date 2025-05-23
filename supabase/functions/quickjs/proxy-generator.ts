import { hostLog } from '../_shared/utils.ts';
import { QuickJSAsyncContext, QuickJSHandle } from "quickjs-emscripten";
import { SerializedVMState, saveStackRun, _generateUUID, getSupabaseClient } from './vm-state-manager.ts';

// Global storage for promise resolvers (JavaScript functions, not QuickJS handles)
const globalResolvers = new Map<string, {
  resolve: (value?: QuickJSHandle) => void;
  reject: (value?: QuickJSHandle) => void;
}>();

// Declare global __callHostTool__ function
// This is called by the VM's proxy.
// declare global {
//   function __callHostTool__(service: string, method: string[], args: any[]): any;
// }
// Note: The actual __callHostTool__ that this proxy generator sets up is defined *within* the VM context.
// The global __callHostTool__ in quickjs/index.ts is a direct-fetcher, not for this suspend/resume proxy.

/**
 * Generates a proxy for a service that will suspend the VM on service method calls
 */
export function generateServiceProxy(
  ctx: QuickJSAsyncContext, 
  taskRunId: string,
  currentTaskCode: string, 
  currentTaskName: string, 
  currentTaskInput: any
) {
  // Create the root service proxy
  const serviceProxy = ctx.newObject();
  
  // Create admin object
  const adminProxy = ctx.newObject();
  
  // Create domains object under admin
  const domainsProxy = ctx.newObject();
  
  // Create the list function that will suspend the VM
  const listFn = ctx.newAsyncifiedFunction("list", async (...argHandles: QuickJSHandle[]) => {
    const args = argHandles.map(h => ctx.dump(h));
    
    hostLog("ServiceProxy", "info", `GAPI admin.domains.list called with args:`, args);
    
    const stackRunId = _generateUUID();
    
    // Get the current stack run ID from the VM global context
    const currentStackRunIdHandle = ctx.getProp(ctx.global, "__currentStackRunId");
    const currentStackRunId = ctx.typeof(currentStackRunIdHandle) === 'string' ? ctx.getString(currentStackRunIdHandle) : undefined;
    currentStackRunIdHandle?.dispose();
    
    const vmState: SerializedVMState = {
      stackRunId,
      taskRunId,
      suspended: true,
      suspendedAt: new Date().toISOString(),
      waitingOnStackRunId: undefined, // Service calls don't wait on anything - they ARE what's being waited on
      taskCode: currentTaskCode,
      taskName: currentTaskName,
      taskInput: currentTaskInput,
      checkpoint: { 
        currentServiceCall: {
          service: "gapi",
          method: "admin.domains.list",
          stackRunId: stackRunId,
          args: args,
          step: 1 // This is step 1 (domains call)
        }
      }
    };
    
    // Set suspension info in global with stack run ID for checkpoint tracking
    const suspendInfoObj = ctx.newObject();
    ctx.setProp(suspendInfoObj, "suspended", ctx.true);
    ctx.setProp(suspendInfoObj, "stackRunId", ctx.newString(stackRunId));
    ctx.setProp(suspendInfoObj, "serviceName", ctx.newString("gapi"));
    ctx.setProp(suspendInfoObj, "method", ctx.newString("admin.domains.list"));
    ctx.setProp(ctx.global, "__suspendInfo__", suspendInfoObj);
    suspendInfoObj.dispose();
    
    // Save stack run with the current stack run as parent
    await saveStackRun(
      "gapi", // service name
      "admin.domains.list", // method path
      args,
      vmState,
      taskRunId,
      currentStackRunId // Pass the current stack run as parent
    );
    
    // CHECKPOINT APPROACH: Update the parent stack run's VM state to include checkpoint data
    if (currentStackRunId) {
      hostLog("ServiceProxy", "info", `Updating parent stack run ${currentStackRunId} to wait for service call ${stackRunId}`);
      
      // Get the parent stack run's current VM state
      const supabase = getSupabaseClient();
      if (supabase) {
        const { data: parentStackRun, error } = await supabase
          .from('stack_runs')
          .select('vm_state')
          .eq('id', currentStackRunId)
          .single();
          
        if (!error && parentStackRun && parentStackRun.vm_state) {
          // Update parent's VM state with checkpoint information
          const updatedParentVmState = {
            ...parentStackRun.vm_state,
            waitingOnStackRunId: stackRunId,
            suspended: true,
            checkpoint: {
              ...parentStackRun.vm_state.checkpoint,
              pendingServiceCall: {
                service: "gapi",
                method: "admin.domains.list", 
                stackRunId: stackRunId,
                timestamp: new Date().toISOString()
              }
            }
          };
          
          // Update the parent stack run in the database
          const { error: updateError } = await supabase
            .from('stack_runs')
            .update({ 
              vm_state: updatedParentVmState,
              waiting_on_stack_run_id: stackRunId,
              status: 'suspended_waiting_child',
              updated_at: new Date().toISOString()
            })
            .eq('id', currentStackRunId);
            
          if (updateError) {
            hostLog("ServiceProxy", "error", `Failed to update parent stack run ${currentStackRunId}: ${updateError.message}`);
          } else {
            hostLog("ServiceProxy", "info", `Parent stack run ${currentStackRunId} updated with checkpoint data for ${stackRunId}`);
          }
        }
      }
    }
    
    // Create a promise that will be resolved when VM resumes
    const deferred = ctx.newPromise();
    
    // Store the resolver in global map
    globalResolvers.set(stackRunId, {
      resolve: deferred.resolve,
      reject: deferred.reject
    });
    
    hostLog("ServiceProxy", "info", `VM suspended for gapi.admin.domains.list, stackRunId: ${stackRunId}`);
    
    return deferred.handle;
  });
  
  // Set up the structure: gapi.admin.domains.list
  ctx.setProp(domainsProxy, "list", listFn);
  listFn.dispose();
  
  ctx.setProp(adminProxy, "domains", domainsProxy);
  domainsProxy.dispose();
  
  ctx.setProp(serviceProxy, "admin", adminProxy);
  adminProxy.dispose();
  
  // Also create admin.users.list for the second call in the task
  const usersProxy = ctx.newObject();
  const usersListFn = ctx.newAsyncifiedFunction("list", async (...argHandles: QuickJSHandle[]) => {
    const args = argHandles.map(h => ctx.dump(h));
    
    hostLog("ServiceProxy", "info", `GAPI admin.users.list called with args:`, args);
    
    const stackRunId = _generateUUID();
    
    // Get the current stack run ID from the VM global context
    const currentStackRunIdHandle = ctx.getProp(ctx.global, "__currentStackRunId");
    const currentStackRunId = ctx.typeof(currentStackRunIdHandle) === 'string' ? ctx.getString(currentStackRunIdHandle) : undefined;
    currentStackRunIdHandle?.dispose();
    
    const vmState: SerializedVMState = {
      stackRunId,
      taskRunId,
      suspended: true,
      suspendedAt: new Date().toISOString(),
      waitingOnStackRunId: undefined, // Service calls don't wait on anything - they ARE what's being waited on
      taskCode: currentTaskCode,
      taskName: currentTaskName,
      taskInput: currentTaskInput,
      checkpoint: { 
        currentServiceCall: {
          service: "gapi",
          method: "admin.users.list",
          stackRunId: stackRunId,
          args: args,
          step: 2 // This is step 2 (users call)
        }
      }
    };
    
    // Set suspension info in global with stack run ID for checkpoint tracking
    const suspendInfoObj = ctx.newObject();
    ctx.setProp(suspendInfoObj, "suspended", ctx.true);
    ctx.setProp(suspendInfoObj, "stackRunId", ctx.newString(stackRunId));
    ctx.setProp(suspendInfoObj, "serviceName", ctx.newString("gapi"));
    ctx.setProp(suspendInfoObj, "method", ctx.newString("admin.users.list"));
    ctx.setProp(ctx.global, "__suspendInfo__", suspendInfoObj);
    suspendInfoObj.dispose();
    
    // Save stack run with the current stack run as parent
    await saveStackRun(
      "gapi", // service name
      "admin.users.list", // method path
      args,
      vmState,
      taskRunId,
      currentStackRunId // Pass the current stack run as parent
    );
    
    // CHECKPOINT APPROACH: Update the parent stack run's VM state to include checkpoint data
    if (currentStackRunId) {
      hostLog("ServiceProxy", "info", `Updating parent stack run ${currentStackRunId} to wait for service call ${stackRunId}`);
      
      // Get the parent stack run's current VM state
      const supabase = getSupabaseClient();
      if (supabase) {
        const { data: parentStackRun, error } = await supabase
          .from('stack_runs')
          .select('vm_state')
          .eq('id', currentStackRunId)
          .single();
          
        if (!error && parentStackRun && parentStackRun.vm_state) {
          // Update parent's VM state with checkpoint information
          const updatedParentVmState = {
            ...parentStackRun.vm_state,
            waitingOnStackRunId: stackRunId,
            suspended: true,
            checkpoint: {
              ...parentStackRun.vm_state.checkpoint,
              pendingServiceCall: {
                service: "gapi",
                method: "admin.users.list", 
                stackRunId: stackRunId,
                timestamp: new Date().toISOString()
              }
            }
          };
          
          // Update the parent stack run in the database
          const { error: updateError } = await supabase
            .from('stack_runs')
            .update({ 
              vm_state: updatedParentVmState,
              waiting_on_stack_run_id: stackRunId,
              status: 'suspended_waiting_child',
              updated_at: new Date().toISOString()
            })
            .eq('id', currentStackRunId);
            
          if (updateError) {
            hostLog("ServiceProxy", "error", `Failed to update parent stack run ${currentStackRunId}: ${updateError.message}`);
          } else {
            hostLog("ServiceProxy", "info", `Parent stack run ${currentStackRunId} updated with checkpoint data for ${stackRunId}`);
          }
        }
      }
    }
    
    // Create a promise that will be resolved when VM resumes
    const deferred = ctx.newPromise();
    
    // Store the resolver in global map
    globalResolvers.set(stackRunId, {
      resolve: deferred.resolve,
      reject: deferred.reject
    });
    
    hostLog("ServiceProxy", "info", `VM suspended for gapi.admin.users.list, stackRunId: ${stackRunId}`);
    
    return deferred.handle;
  });
  
  ctx.setProp(usersProxy, "list", usersListFn);
  usersListFn.dispose();
  
  // Get the admin proxy again and add users to it
  const adminProxyAgain = ctx.getProp(serviceProxy, "admin");
  ctx.setProp(adminProxyAgain, "users", usersProxy);
  adminProxyAgain.dispose();
  usersProxy.dispose();
  
  return serviceProxy;
}

/**
 * Resolve a promise for a specific stack run ID with a result
 */
export function resolvePromiseForStackRun(stackRunId: string, result: any): void {
  const resolvers = globalResolvers.get(stackRunId);
  if (resolvers) {
    hostLog("Proxy-Generator", "info", `Resolving promise for stackRunId: ${stackRunId}`);
    resolvers.resolve(result);
    globalResolvers.delete(stackRunId);
  } else {
    hostLog("Proxy-Generator", "warn", `No promise resolver found for stackRunId: ${stackRunId}`);
  }
}

/**
 * Reject a promise for a specific stack run ID with an error
 */
export function rejectPromiseForStackRun(stackRunId: string, error: any): void {
  const resolvers = globalResolvers.get(stackRunId);
  if (resolvers) {
    hostLog("Proxy-Generator", "info", `Rejecting promise for stackRunId: ${stackRunId}`);
    resolvers.reject(error);
    globalResolvers.delete(stackRunId);
  } else {
    hostLog("Proxy-Generator", "warn", `No promise resolver found for stackRunId: ${stackRunId}`);
  }
}

// Removed createHandleFromJson as it's not directly used by generateServiceProxy here
// and a similar one exists in quickjs/index.ts. If needed, it should be consolidated.

// Removed createHostToolFn as it's unused and has unresolved issues.
// The primary proxy generation is handled by generateServiceProxy. 