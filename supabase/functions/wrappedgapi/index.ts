import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from 'https://deno.land/std@0.131.0/http/server.ts'
import { corsHeaders } from '../quickjs/cors.ts'
import { createServiceProxy } from 'npm:sdk-http-wrapper@1.0.10/client'
import { google } from 'npm:googleapis@^133'
import type { OAuth2Client } from 'npm:google-auth-library@^9'
import { processSdkRequest } from "npm:sdk-http-wrapper@1.0.10/server"

function getSupabaseUrl() {
  return Deno.env.get('SUPABASE_EDGE_RUNTIME_IS_LOCAL') === 'true'
    ? 'http://kong:8000'
    : Deno.env.get('SUPABASE_URL') ?? 'http://localhost:8000'
}
const keystore = createServiceProxy('keystore', {
  baseUrl: `${getSupabaseUrl()}/functions/v1/wrappedkeystore`,
  headers: {
    'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
    'apikey': Deno.env.get('SUPABASE_ANON_KEY')
  }
})

type ServiceAccountCredentials = {
  client_email: string
  private_key: string
}
let cachedCreds: ServiceAccountCredentials | null = null
const authClients: Record<string, OAuth2Client> = {}

async function getCredentialsFromKeystore(): Promise<ServiceAccountCredentials> {
  if (cachedCreds) return cachedCreds
  const jsonString = await keystore.getKey('global', 'GAPI_KEY')
  if (!jsonString) throw new Error('GAPI_KEY not found')
  const creds = JSON.parse(jsonString)
  if (!creds.client_email || !creds.private_key) throw new Error('Missing fields')
  cachedCreds = creds
  return creds
}

async function getAuthClient(scopes: string[], user: string | null): Promise<OAuth2Client> {
  const key = scopes.sort().join(',') + '::' + (user || '')
  if (authClients[key]) return authClients[key]
  const creds = await getCredentialsFromKeystore()
  const jwt = new google.auth.JWT(
    creds.client_email,
    undefined,
    creds.private_key,
    scopes,
    user || undefined
  )
  await jwt.authorize()
  authClients[key] = jwt as unknown as OAuth2Client
  return authClients[key]
}

function getScopesForCall(chain: any[]): string[] {
  const svc = chain?.[0]?.property
  if (svc === 'gmail') return [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://mail.google.com/'
  ]
  if (svc === 'admin') return [
    'https://www.googleapis.com/auth/admin.directory.user.readonly',
    'https://www.googleapis.com/auth/admin.directory.domain.readonly',
    'https://www.googleapis.com/auth/admin.directory.customer.readonly'
  ]
  return ['https://www.googleapis.com/auth/admin.directory.user.readonly']
}

serve(async (req) => {
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: corsHeaders })
  try {
    const body = await req.json()
    const chain = body?.chain
    if (!Array.isArray(chain) || !chain.length)
      throw new Error("Invalid 'chain'")
    let config = body?.config || {}
    let args: any[] = []
    const last = chain[chain.length - 1]
    if (last?.type === 'call' && Array.isArray(last.args)) {
      const lastArg = last.args[last.args.length - 1]
      if (typeof lastArg === 'object' && lastArg !== null &&
        (lastArg.__impersonate || Object.keys(lastArg).length > 0)) {
        args = last.args.slice(0, -1)
        config = { ...config, ...lastArg }
      } else {
        args = last.args
      }
    }
    const user = config.__impersonate || null
    const scopes = getScopesForCall(chain)
    const auth = await getAuthClient(scopes, user)
    const svc = chain[0]?.property
    let instance: any
    if (svc === 'gmail') instance = google.gmail({ version: 'v1', auth })
    else if (svc === 'admin') instance = google.admin({ version: 'directory_v1', auth })
    else throw new Error(`Unsupported service: ${svc}`)
    const sdkConfig = { [svc]: { instance } }
    const result = await processSdkRequest({
      service: svc,
      chain: chain.slice(1),
      args
    }, sdkConfig[svc])
    if (result.status >= 400)
      throw { status: result.status, message: `SDK call failed`, details: result.body }
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    })
  } catch (e) {
    const status = (e as any)?.status || 500
    const message = (e as any)?.message || 'Internal Server Error'
    const details = (e as any)?.details
    return new Response(JSON.stringify({ success: false, error: message, details }), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
