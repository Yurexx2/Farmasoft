import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { computeCheck } from 'telegram/Password'
import { ConnectionTCPObfuscated } from 'telegram/network'
import { NewMessage, NewMessageEvent } from 'telegram/events'

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

// ─── Inbound message hook (recruiting bot) ──────────────────────────────────
// A single callback the telegram-bot module registers. It fires for every
// incoming private message. The GramJS event handler is (re)attached on every
// client connection — reload, fresh auth — so it survives restarts.
export interface InboundTelegram {
  peerId: string
  messageId: number
  text: string
  date: number   // unix seconds
}
type InboundCb = (msg: InboundTelegram) => void
let inboundCb: InboundCb | null = null

export function onTelegramInbound(cb: InboundCb): void {
  inboundCb = cb
}

function attachInboundHandler(client: TelegramClient): void {
  client.addEventHandler((event: NewMessageEvent) => {
    try {
      const msg = event.message
      // Only candidate→us private messages. Skip our own outgoing ones.
      if (msg.out) return
      if (!event.isPrivate) return
      const senderId = msg.senderId
      if (!senderId) return
      inboundCb?.({
        peerId: String(senderId),
        messageId: msg.id,
        text: msg.message || '',
        date: msg.date || Math.floor(Date.now() / 1000),
      })
    } catch (e) {
      console.error('[telegram inbound]', (e as Error).message)
    }
  }, new NewMessage({}))
}

// Pending auth state (in-memory, between phone-submit and code-submit)
interface PendingAuth {
  client: TelegramClient
  creds: TelegramCreds
  phoneCodeHash: string
  needsPassword?: boolean
}
let pendingAuth: PendingAuth | null = null

export async function telegramReloadFromSession(creds: TelegramCreds): Promise<{ ok: boolean; me?: { username?: string; firstName?: string }; error?: string; fatal?: boolean }> {
  if (!creds.session) return { ok: false, error: 'No session string saved' }
  try {
    // Drop any stale client still held in memory before opening a fresh one.
    if (activeClient) {
      try { await activeClient.disconnect() } catch { /* ignore */ }
      activeClient = null
    }
    const session = new StringSession(creds.session)
    const client = new TelegramClient(session, creds.apiId, creds.apiHash, {
      // High retry budget + auto-reconnect so a transient network blip never
      // permanently drops the connection — only a process restart does.
      connectionRetries: 100,
      retryDelay: 2000,
      autoReconnect: true,
      connection: ConnectionTCPObfuscated,
      useWSS: true,
    })
    await client.connect()
    const isAuthorized = await client.isUserAuthorized()
    if (!isAuthorized) { await client.disconnect(); return { ok: false, error: 'Session expirée — reconnexion requise' } }
    const me = await client.getMe() as { username?: string; firstName?: string }
    activeClient = client
    activeCreds = creds
    attachInboundHandler(client)
    return { ok: true, me: { username: me.username, firstName: me.firstName } }
  } catch (err: unknown) {
    const msg = (err as Error).message || ''
    // AUTH_KEY_DUPLICATED / AUTH_KEY_UNREGISTERED → the session is revoked for
    // good (Telegram kills a key used from two places at once). Retrying is
    // pointless; the caller must drop it and re-authenticate.
    const fatal = /AUTH_KEY_DUPLICATED|AUTH_KEY_UNREGISTERED|SESSION_REVOKED/i.test(msg)
    return { ok: false, error: msg, fatal }
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
    attachInboundHandler(pendingAuth.client)
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
): Promise<{ ok: boolean; messageId?: number; peerId?: string; accessHash?: string; error?: string }> {
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
        return { ok: true, messageId: sent.id, peerId: String(user.id), accessHash: user.accessHash != null ? String(user.accessHash) : undefined }
      } catch (e: unknown) {
        return { ok: false, error: 'Numéro non joignable sur Telegram: ' + (e as Error).message }
      }
    }

    // Otherwise try as username
    if (!target.startsWith('@')) target = '@' + target
    const entity = await activeClient.getEntity(target as string) as unknown as { id: bigint; accessHash?: bigint }
    const sent = await activeClient.sendMessage(entity as never, { message }) as { id: number }
    return { ok: true, messageId: sent.id, peerId: String(entity.id), accessHash: entity.accessHash != null ? String(entity.accessHash) : undefined }
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message }
  }
}

// ─── Bot helpers — operate on a stored peerId (Telegram user id string) ──────

/**
 * Resolve a stored peer to a usable GramJS input peer. When the access hash
 * is known (persisted in the DB) it builds the input peer directly — this is
 * the only path that survives a server restart, since GramJS keeps its entity
 * cache in memory only. Falls back to the cache for legacy rows without a hash.
 */
async function resolvePeer(peerId: string, accessHash?: string | null): Promise<Api.TypeInputPeer> {
  if (!activeClient) throw new Error('Compte Telegram non connecté')
  if (accessHash) {
    return new Api.InputPeerUser({
      userId: BigInt(peerId) as unknown as never,
      accessHash: BigInt(accessHash) as unknown as never,
    })
  }
  return await activeClient.getInputEntity(BigInt(peerId) as unknown as never) as Api.TypeInputPeer
}

/** Send a message to a peer the bot is already in a conversation with. */
export async function telegramSendToPeer(
  peerId: string, accessHash: string | null, message: string,
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  if (!activeClient) return { ok: false, error: 'Compte Telegram non connecté' }
  try {
    const peer = await resolvePeer(peerId, accessHash)
    const sent = await activeClient.sendMessage(peer as never, { message }) as { id: number }
    return { ok: true, messageId: sent.id }
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Show the "typing…" indicator to a peer (auto-clears after ~6s). */
export async function telegramSetTyping(peerId: string, accessHash?: string | null): Promise<void> {
  if (!activeClient) return
  try {
    const peer = await resolvePeer(peerId, accessHash)
    await activeClient.invoke(new Api.messages.SetTyping({
      peer: peer as never,
      action: new Api.SendMessageTypingAction(),
    }))
  } catch { /* non-critical */ }
}

/** Delete a message on Telegram for everyone (revoke), like the Telegram app. */
export async function telegramDeleteMessage(
  peerId: string, accessHash: string | null, tgMessageId: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!activeClient) return { ok: false, error: 'Compte Telegram non connecté' }
  try {
    const peer = await resolvePeer(peerId, accessHash)
    await activeClient.deleteMessages(peer as never, [tgMessageId], { revoke: true })
    return { ok: true }
  } catch (err: unknown) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Mark the conversation as read up to the latest message. */
export async function telegramMarkRead(peerId: string, accessHash?: string | null): Promise<void> {
  if (!activeClient) return
  try {
    const peer = await resolvePeer(peerId, accessHash)
    await activeClient.invoke(new Api.messages.ReadHistory({ peer: peer as never }))
  } catch { /* non-critical */ }
}

/**
 * Fetch messages received from a peer since `minId` — used to recover any
 * candidate replies that arrived while the bot/server was offline.
 */
export async function telegramFetchSince(
  peerId: string, accessHash: string | null, minId: number,
): Promise<InboundTelegram[]> {
  if (!activeClient) return []
  try {
    const peer = await resolvePeer(peerId, accessHash)
    const messages = await activeClient.getMessages(peer as never, { minId, limit: 100 })
    return messages
      .filter(m => !m.out && (m.message || '').length > 0)
      .map(m => ({
        peerId,
        messageId: m.id,
        text: m.message || '',
        date: m.date || Math.floor(Date.now() / 1000),
      }))
      .sort((a, b) => a.messageId - b.messageId)
  } catch (e) {
    console.error('[telegram fetchSince]', (e as Error).message)
    return []
  }
}

// ─── Dialog import — pull Alena's existing Telegram chats ────────────────────
export interface TgDialogMsg { id: number; text: string; out: boolean; date: number }
export interface TgDialog {
  peerId: string
  accessHash?: string
  name: string
  username?: string
  phone?: string
  messages: TgDialogMsg[]
}

/**
 * Fetch the most recent private (one-to-one) conversations from the connected
 * account, with a slice of each thread's message history. Groups, channels and
 * bots are skipped.
 */
export async function telegramFetchDialogs(
  maxDialogs = 80, msgsPerDialog = 30,
): Promise<TgDialog[]> {
  if (!activeClient) return []
  const out: TgDialog[] = []
  const dialogs = await activeClient.getDialogs({ limit: maxDialogs })
  for (const d of dialogs) {
    try {
      const entity = (d as unknown as { entity?: { className?: string } }).entity
      if (!entity || entity.className !== 'User') continue
      const user = entity as unknown as {
        id: unknown; accessHash?: unknown; firstName?: string; lastName?: string
        username?: string; phone?: string; bot?: boolean; self?: boolean
      }
      // Skip bots, the account's own Saved Messages, and the official
      // Telegram service account (id 777000 — login codes / notifications).
      if (user.bot || user.self || String(user.id) === '777000') continue
      const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
        || user.username || String(user.id)
      const msgs = await activeClient.getMessages(entity as never, { limit: msgsPerDialog })
      const messages: TgDialogMsg[] = msgs
        .filter(m => (m.message || '').length > 0)
        .map(m => ({ id: m.id, text: m.message || '', out: !!m.out, date: m.date || 0 }))
        .sort((a, b) => a.id - b.id)
      out.push({
        peerId: String(user.id),
        accessHash: user.accessHash != null ? String(user.accessHash) : undefined,
        name,
        username: user.username || undefined,
        phone: user.phone || undefined,
        messages,
      })
    } catch (e) {
      console.error('[telegram dialog]', (e as Error).message)
    }
  }
  return out
}

export function telegramIsConnected(): boolean {
  if (!activeClient || !activeCreds) return false
  // `connected` reflects the live MTProto socket. A client object can linger
  // in memory after its socket silently dies — checking only `activeClient`
  // would wrongly report "connected" and stop the self-heal from running.
  const live = (activeClient as unknown as { connected?: boolean }).connected
  return live !== false
}

export function telegramGetActiveCreds(): TelegramCreds | null {
  return activeCreds
}
