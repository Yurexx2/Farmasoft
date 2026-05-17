import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { computeCheck } from 'telegram/Password'
import { ConnectionTCPObfuscated } from 'telegram/network'

export interface TelegramCreds {
  apiId: number
  apiHash: string
  phoneNumber: string
  session?: string  // saved StringSession after auth
}

// Singleton client (one user account = one persistent client)
let activeClient: TelegramClient | null = null
let activeCreds: TelegramCreds | null = null

// Telegram web gateway hostnames (per DC) — reachable through corporate firewalls
// that block direct MTProto IPs but allow HTTPS/WSS to *.web.telegram.org.
// DC2 is the production DC for +380 (Ukraine) numbers.
const WEB_DC: Record<number, string> = {
  1: 'pluto.web.telegram.org',
  2: 'venus.web.telegram.org',
  3: 'aurora.web.telegram.org',
  4: 'vesta.web.telegram.org',
  5: 'flora.web.telegram.org',
}
const DEFAULT_WEB_DC_ID = 2
function applyWebDC(session: StringSession, dcId = DEFAULT_WEB_DC_ID): void {
  session.setDC(dcId, WEB_DC[dcId], 443)
}

// Pending auth state (in-memory, between phone-submit and code-submit)
interface PendingAuth {
  client: TelegramClient
  creds: TelegramCreds
  phoneCodeHash: string
  needsPassword?: boolean
}
let pendingAuth: PendingAuth | null = null

export async function telegramReloadFromSession(creds: TelegramCreds): Promise<{ ok: boolean; me?: { username?: string; firstName?: string }; error?: string }> {
  if (!creds.session) return { ok: false, error: 'No session string saved' }
  try {
    const session = new StringSession(creds.session)
    const client = new TelegramClient(session, creds.apiId, creds.apiHash, {
      connectionRetries: 3,
      connection: ConnectionTCPObfuscated,
      useWSS: true,
    })
    await client.connect()
    const isAuthorized = await client.isUserAuthorized()
    if (!isAuthorized) { await client.disconnect(); return { ok: false, error: 'Session expirée — reconnexion requise' } }
    const me = await client.getMe() as { username?: string; firstName?: string }
    activeClient = client
    activeCreds = creds
    return { ok: true, me: { username: me.username, firstName: me.firstName } }
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function telegramStartAuth(apiId: number, apiHash: string, phoneNumber: string): Promise<{ ok: boolean; error?: string; deliveryType?: string; nextType?: string; timeout?: number }> {
  try {
    // Cleanup any previous pending auth
    if (pendingAuth) { try { await pendingAuth.client.disconnect() } catch { /* ignore */ } pendingAuth = null }

    const session = new StringSession('')
    const client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 3,
      connection: ConnectionTCPObfuscated,
      useWSS: true,
    })
    await client.connect()

    const sendCodeResult = await client.invoke(new Api.auth.SendCode({
      phoneNumber,
      apiId,
      apiHash,
      settings: new Api.CodeSettings({ allowFlashcall: false, currentNumber: false, allowAppHash: true }),
    })) as { phoneCodeHash: string; type?: { className: string; length?: number }; nextType?: { className: string }; timeout?: number }

    const deliveryType = sendCodeResult.type?.className?.replace(/^auth\.sentCodeType/i, '')
    const nextType = sendCodeResult.nextType?.className?.replace(/^auth\.codeType/i, '')
    console.log('[telegram] SendCode →', { deliveryType, nextType, timeout: sendCodeResult.timeout })

    pendingAuth = {
      client,
      creds: { apiId, apiHash, phoneNumber },
      phoneCodeHash: sendCodeResult.phoneCodeHash,
    }
    return { ok: true, deliveryType, nextType, timeout: sendCodeResult.timeout }
  } catch (err: unknown) {
    const msg = (err as Error).message
    if (msg.includes('PHONE_NUMBER_INVALID')) return { ok: false, error: 'Numéro invalide (format +380...)' }
    if (msg.includes('API_ID_INVALID'))      return { ok: false, error: 'api_id ou api_hash invalide' }
    return { ok: false, error: msg }
  }
}

export async function telegramResendCode(): Promise<{ ok: boolean; error?: string; deliveryType?: string; nextType?: string }> {
  if (!pendingAuth) return { ok: false, error: 'Aucune authentification en cours' }
  try {
    const r = await pendingAuth.client.invoke(new Api.auth.ResendCode({
      phoneNumber: pendingAuth.creds.phoneNumber,
      phoneCodeHash: pendingAuth.phoneCodeHash,
    })) as { phoneCodeHash: string; type?: { className: string }; nextType?: { className: string } }
    pendingAuth.phoneCodeHash = r.phoneCodeHash
    const deliveryType = r.type?.className?.replace(/^auth\.sentCodeType/i, '')
    const nextType = r.nextType?.className?.replace(/^auth\.codeType/i, '')
    console.log('[telegram] ResendCode →', { deliveryType, nextType })
    return { ok: true, deliveryType, nextType }
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function telegramSubmitCode(code: string): Promise<{ ok: boolean; needsPassword?: boolean; session?: string; me?: { username?: string; firstName?: string }; error?: string }> {
  if (!pendingAuth) return { ok: false, error: 'Aucune authentification en cours — recommencez avec votre numéro' }
  try {
    await pendingAuth.client.invoke(new Api.auth.SignIn({
      phoneNumber: pendingAuth.creds.phoneNumber,
      phoneCodeHash: pendingAuth.phoneCodeHash,
      phoneCode: code,
    }))
    return finalizeAuth()
  } catch (err: unknown) {
    const msg = (err as Error).message
    if (msg.includes('SESSION_PASSWORD_NEEDED')) {
      pendingAuth.needsPassword = true
      return { ok: false, needsPassword: true }
    }
    if (msg.includes('PHONE_CODE_INVALID')) return { ok: false, error: 'Code incorrect' }
    if (msg.includes('PHONE_CODE_EXPIRED')) return { ok: false, error: 'Code expiré — recommencez' }
    return { ok: false, error: msg }
  }
}

export async function telegramSubmitPassword(password: string): Promise<{ ok: boolean; session?: string; me?: { username?: string; firstName?: string }; error?: string }> {
  if (!pendingAuth) return { ok: false, error: 'Aucune authentification en cours' }
  if (!pendingAuth.needsPassword) return { ok: false, error: 'Mot de passe non requis pour ce compte' }
  try {
    const passwordInfo = await pendingAuth.client.invoke(new Api.account.GetPassword())
    const passwordCheck = await computeCheck(passwordInfo, password)
    await pendingAuth.client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }))
    return finalizeAuth()
  } catch (err: unknown) {
    const msg = (err as Error).message
    if (msg.includes('PASSWORD_HASH_INVALID')) return { ok: false, error: 'Mot de passe incorrect' }
    return { ok: false, error: msg }
  }
}

async function finalizeAuth(): Promise<{ ok: boolean; session?: string; me?: { username?: string; firstName?: string }; error?: string }> {
  if (!pendingAuth) return { ok: false, error: 'Aucune authentification en cours' }
  try {
    const sessionStr = (pendingAuth.client.session as StringSession).save() as unknown as string
    const me = await pendingAuth.client.getMe() as { username?: string; firstName?: string }

    activeClient = pendingAuth.client
    activeCreds = { ...pendingAuth.creds, session: sessionStr }
    pendingAuth = null

    return { ok: true, session: sessionStr, me: { username: me.username, firstName: me.firstName } }
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function telegramDisconnect(): Promise<void> {
  if (activeClient) {
    try { await activeClient.invoke(new Api.auth.LogOut()) } catch { /* ignore */ }
    try { await activeClient.disconnect() } catch { /* ignore */ }
    activeClient = null
    activeCreds = null
  }
  if (pendingAuth) {
    try { await pendingAuth.client.disconnect() } catch { /* ignore */ }
    pendingAuth = null
  }
}

export async function telegramSend(
  toPhoneOrUsername: string,
  message: string,
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  if (!activeClient || !activeCreds) return { ok: false, error: 'Compte Telegram non connecté' }
  try {
    let target: string | number = toPhoneOrUsername.trim()

    // If looks like a phone, try to resolve via importContacts
    if (/^\+?\d{10,}$/.test(target)) {
      const phone = target.startsWith('+') ? target : '+' + target
      try {
        // Import as contact to get user
        const result = await activeClient.invoke(new Api.contacts.ImportContacts({
          contacts: [new Api.InputPhoneContact({
            clientId: BigInt(Date.now()) as unknown as bigint,
            phone,
            firstName: 'C',
            lastName:  '_',
          })],
        })) as { users: Array<{ id: bigint; accessHash?: bigint }> }
        const user = result.users?.[0]
        if (!user) return { ok: false, error: 'Numéro pas inscrit sur Telegram' }
        const sent = await activeClient.sendMessage(user as never, { message }) as { id: number }
        return { ok: true, messageId: sent.id }
      } catch (e: unknown) {
        return { ok: false, error: 'Numéro non joignable sur Telegram: ' + (e as Error).message }
      }
    }

    // Otherwise try as username
    if (!target.startsWith('@')) target = '@' + target
    const sent = await activeClient.sendMessage(target as string, { message }) as { id: number }
    return { ok: true, messageId: sent.id }
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message }
  }
}

export function telegramIsConnected(): boolean {
  return activeClient !== null && activeCreds !== null
}

export function telegramGetActiveCreds(): TelegramCreds | null {
  return activeCreds
}
