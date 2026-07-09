/**
 * Core RPC surface — offline / browser-compatible.
 * Live relay tests live in `test/live-madmail.ts` (env-driven).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { DeltaChatSDK, ALL_DC_EVENTS, ALL_WS_ACTIONS } from '../../sdk'
import { MemoryStore } from '../../store'
import { installMockWebSocket, buildRawMime, waitForEvent } from './helpers/web'

describe('Delta Chat RPC Core (web-compatible)', () => {
  let account: any
  let restore: (() => void) | null = null

  beforeEach(() => {
    restore = installMockWebSocket()
    const dc = DeltaChatSDK({ logLevel: 'error', store: new MemoryStore() })
    account = dc.addAccount('alice@relay.example', 'pass', 'https://relay.example')
  })

  afterEach(() => {
    account?.disconnect?.()
    restore?.()
  })

  it('exposes exhaustive event + WS action registries', () => {
    expect(ALL_DC_EVENTS.length).toBeGreaterThanOrEqual(18)
    expect(ALL_WS_ACTIONS.length).toBe(12)
  })

  it('status() returns account shape without network', () => {
    const status = account.status()
    expect(status).toHaveProperty('id')
    expect(status).toHaveProperty('email')
    expect(status.email).toBe('alice@relay.example')
  })

  it('connects via MockWebSocket and lists mailboxes', async () => {
    await account.connect('https://relay.example')
    await new Promise(r => setTimeout(r, 15))
    expect(account.status().isConnected).toBe(true)
    const mboxes = await account.wsRequest('list_mailboxes', {})
    expect(Array.isArray(mboxes)).toBe(true)
  })

  it('processIncomingRaw delivers DC_EVENT_INCOMING_MSG', async () => {
    const p = waitForEvent(account, 'DC_EVENT_INCOMING_MSG')
    await account.processIncomingRaw({
      uid: 0,
      body: buildRawMime({
        from: 'bob@relay.example',
        to: 'alice@relay.example',
        body: 'RPC test hello',
      }),
    })
    const e: any = await p
    expect(e.msg.text).toContain('RPC test hello')
  })

  it('getChatList is available', async () => {
    const chats = await account.getChatList()
    expect(Array.isArray(chats)).toBe(true)
  })

  it('capabilities() is web-shaped', () => {
    const caps = account.capabilities()
    expect(caps.webxdc).toBe(true)
    expect(caps.location).toBe(true)
    expect(['webrtc', 'signaling-only', 'none']).toContain(caps.calls)
  })
})

