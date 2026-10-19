// Orca Native push plugin. Watches agent.status.changed and asks the Cloudflare
// Worker to APNs-notify paired phones. Credentials live in plugin storage; run
// "Native Push: Show credentials" to put the phone pairing link on screen.

const DEFAULT_RELAY = 'https://orca-native-push.reily.workers.dev'
const STORAGE_SERVER_ID = 'pushServerId'
const STORAGE_SERVER_SECRET = 'pushServerSecret'
const STORAGE_WORKTREE_NAMES = 'worktreeNames'
const SETTINGS_RELAY_URL = 'relayURL'

/** @type {Map<string, string>} */
const lastStateByPane = new Map()

export default function activate(orca) {
  orca.commands.register('push.credentials', async () => {
    const creds = await ensureCredentials(orca)
    await claimServer(orca, creds)
    const link = await pairingLink(creds, orca, 'orcanative')
    const debugLink = await pairingLink(creds, orca, 'orcanative-dev')
    const relay = await resolveRelayURL(orca)
    orca.log(`push credentials: ${link}`)
    await orca.host.call('notifications.show', {
      title: 'Orca Native Push',
      body: `${link}\n\nDebug: ${debugLink}`,
    })
    return {
      serverId: creds.serverId,
      secret: creds.secret,
      relayURL: relay,
      link,
      debugLink,
    }
  })

  orca.commands.register('push.test', async () => {
    const creds = await ensureCredentials(orca)
    await claimServer(orca, creds)
    const result = await notify(
      creds,
      {
        title: 'Orca Native Push',
        body: 'Test alert from the desktop plugin',
        collapseId: 'push-test',
      },
      orca,
    )
    await orca.host.call('notifications.show', {
      title: 'Orca Native Push',
      body: `Test sent: ${result.sent ?? 0} ok, ${result.failed ?? 0} failed`,
    })
    return result
  })

  orca.events.on('worktree.created', async (payload) => {
    const names = await loadWorktreeNames(orca)
    const label = basename(payload.path) || payload.worktreeId
    names[payload.worktreeId] = label
    await orca.host.call('storage.set', { key: STORAGE_WORKTREE_NAMES, value: names })
  })

  orca.events.on('worktree.removed', async (payload) => {
    const names = await loadWorktreeNames(orca)
    delete names[payload.worktreeId]
    await orca.host.call('storage.set', { key: STORAGE_WORKTREE_NAMES, value: names })
  })

  orca.events.on('agent.status.changed', (payload) => {
    void onAgentStatusChanged(orca, payload)
  })

  // Claim the relay as soon as the worker wakes so phones can register before
  // the first agent event. Failures are logged; a later command/event retries.
  void ensureCredentials(orca)
    .then((creds) => claimServer(orca, creds))
    .catch((err) => orca.log(`push relay claim failed: ${err?.message ?? err}`))
}

async function onAgentStatusChanged(orca, payload) {
  const paneKey = typeof payload?.paneKey === 'string' ? payload.paneKey : ''
  const state = typeof payload?.state === 'string' ? payload.state : ''
  if (!paneKey || !state) return

  const previous = lastStateByPane.get(paneKey)
  lastStateByPane.set(paneKey, state)

  const needsInput = state === 'waiting' || state === 'blocked'
  const finished = state === 'done'
  if (!needsInput && !finished) return
  // Ignore the first observation of a pane (history / restore), same as the phone.
  if (previous == null) return
  if (previous === state) return
  if (finished && previous !== 'working' && previous !== 'waiting' && previous !== 'blocked') return
  if (needsInput && previous !== 'working') return

  const names = await loadWorktreeNames(orca)
  const worktreeId = typeof payload.worktreeId === 'string' ? payload.worktreeId : null
  const workspace = (worktreeId && names[worktreeId]) || worktreeId || 'a workspace'
  const title = needsInput
    ? `Agent needs input in ${workspace}`
    : `Agent finished in ${workspace}`
  const body = needsInput ? 'Waiting for your reply' : 'Turn complete'

  try {
    const creds = await ensureCredentials(orca)
    await claimServer(orca, creds)
    await notify(
      creds,
      {
        title,
        body,
        worktreeId: worktreeId ?? undefined,
        collapseId: paneKey.slice(0, 64),
      },
      orca,
    )
  } catch (err) {
    orca.log(`push notify failed: ${err?.message ?? err}`)
  }
}

async function ensureCredentials(orca) {
  const idStored = await orca.host.call('storage.get', { key: STORAGE_SERVER_ID })
  const secretStored = await orca.host.call('storage.get', { key: STORAGE_SERVER_SECRET })
  let serverId = typeof idStored?.value === 'string' ? idStored.value : ''
  let secret = typeof secretStored?.value === 'string' ? secretStored.value : ''
  if (!/^[a-f0-9]{16,}$/i.test(serverId)) {
    serverId = randomHex(16)
    await orca.host.call('storage.set', { key: STORAGE_SERVER_ID, value: serverId })
  }
  if (!/^[a-f0-9]{32,}$/i.test(secret)) {
    secret = randomHex(32)
    await orca.host.call('storage.set', { key: STORAGE_SERVER_SECRET, value: secret })
  }
  return { serverId, secret }
}

async function claimServer(orca, creds) {
  const res = await relayFetch(creds, '/v1/servers', 'POST', {}, orca)
  if (!res.ok) throw new Error(`claim server: ${res.error ?? res.status}`)
}

async function notify(creds, payload, orca) {
  const res = await relayFetch(creds, '/v1/notify', 'POST', payload, orca)
  if (!res.ok) throw new Error(`notify: ${res.error ?? res.status}`)
  return res.body
}

async function relayFetch(creds, path, method, body, orca) {
  const base = (await resolveRelayURL(orca)).replace(/\/$/, '')
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${creds.secret}`,
      'X-Push-Server-Id': creds.serverId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  })
  const json = await response.json().catch(() => ({}))
  return {
    ok: response.ok,
    status: response.status,
    error: typeof json.error === 'string' ? json.error : undefined,
    body: json,
  }
}

async function resolveRelayURL(orca) {
  try {
    const settings = await orca.host.call('settings.get', {})
    const value = settings?.settings?.[SETTINGS_RELAY_URL]
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value.replace(/\/$/, '')
  } catch {
    // settings:own may be refused before consent; fall through.
  }
  return DEFAULT_RELAY
}

async function pairingLink(creds, orca, scheme) {
  const relay = await resolveRelayURL(orca)
  const url = new URL(`${scheme}://push-relay`)
  url.searchParams.set('serverId', creds.serverId)
  url.searchParams.set('secret', creds.secret)
  url.searchParams.set('relay', relay)
  return url.toString()
}

async function loadWorktreeNames(orca) {
  const stored = await orca.host.call('storage.get', { key: STORAGE_WORKTREE_NAMES })
  if (stored?.value && typeof stored.value === 'object' && !Array.isArray(stored.value)) {
    return { ...stored.value }
  }
  return {}
}

function basename(path) {
  if (typeof path !== 'string' || !path) return ''
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || ''
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('')
}
