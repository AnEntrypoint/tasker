/**
 * QuickJS module providing access to external tools via host functions.
 * Relies on globally injected __hostExecuteChain__(service, methodPath, params)
 * and potentially __runtimeConfig__ for configuration details if not handled by host.
 */

if (typeof __hostExecuteChain__ !== 'function') {
  throw new Error("Host function '__hostExecuteChain__' is not available in QuickJS environment.");
}

console.log('[QuickJS Tools] Initializing tools module...');

// Helper function to create a synchronous wrapper around __hostExecuteChain__
// This is needed because QuickJS doesn't handle Promise returns properly in some contexts
function createSyncWrapper(serviceName, methodPath) {
  return function(...args) {
    console.log(`[QuickJS Tools] Calling ${serviceName}.${methodPath} synchronously`);
    // Use a synchronous approach instead of returning a Promise directly
    const result = __hostExecuteChain__(serviceName, methodPath, args[0] || {});
    return result;
  };
}

const tools = {
  keystore: {
    listKeys: (namespace) => createSyncWrapper('keystore', 'listKeys')({ namespace }),
    setKey: (namespace, key, value) => createSyncWrapper('keystore', 'setKey')({ namespace, key, value }),
    getKey: (namespace, key) => createSyncWrapper('keystore', 'getKey')({ namespace, key }),
    listNamespaces: () => createSyncWrapper('keystore', 'listNamespaces')({}),
    getServerTime: () => createSyncWrapper('keystore', 'getServerTime')({})
  },
  openai: {
    createChatCompletion: (params) => {
      console.log('[QuickJS Tools] Calling openai.createChatCompletion...');
      return createSyncWrapper('openai', 'chat.completions.create')(params);
    },
    chat: {
      completions: {
        create: (params) => createSyncWrapper('openai', 'chat.completions.create')(params)
      }
    },
    embeddings: {
      create: (params) => createSyncWrapper('openai', 'embeddings.create')(params)
    }
  },
  supabase: {
    from: (tableName) => {
      console.log(`[QuickJS Tools] Creating Supabase client for table: ${tableName}`);
      return {
        select: (selectParams) => {
          console.log(`[QuickJS Tools] Calling supabase.from(${tableName}).select(${JSON.stringify(selectParams || '*')})`);
          return createSyncWrapper('supabase', 'from.select')({ table: tableName, params: selectParams });
        },
        insert: (insertParams) => {
          console.log(`[QuickJS Tools] Calling supabase.from(${tableName}).insert(...)`);
          return createSyncWrapper('supabase', 'from.insert')({ table: tableName, params: insertParams });
        },
        update: (updateParams, options) => {
          console.log(`[QuickJS Tools] Calling supabase.from(${tableName}).update(...)`);
          return createSyncWrapper('supabase', 'from.update')({ table: tableName, params: updateParams, options: options });
        },
        delete: (options) => {
          console.log(`[QuickJS Tools] Calling supabase.from(${tableName}).delete(...)`);
          return createSyncWrapper('supabase', 'from.delete')({ table: tableName, options: options });
        }
      };
    },
    auth: {
      signUp: (params) => createSyncWrapper('supabase', 'auth.signUp')(params),
      signInWithPassword: (params) => createSyncWrapper('supabase', 'auth.signInWithPassword')(params)
    }
  },
  websearch: {
    search: (params) => {
      console.log(`[QuickJS Tools] Calling websearch.search with query: ${params?.query}`);
      return createSyncWrapper('websearch', 'search')(params);
    },
    getServerTime: () => createSyncWrapper('websearch', 'getServerTime')({})
  }
};

console.log('[QuickJS Tools] Tools module initialized.');
module.exports = tools;
