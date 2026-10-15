import { getStore } from '@netlify/blobs'
import type { Context } from '@netlify/functions'
import { roomBase } from '../lib/room'

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  let body
  try { const text = await req.text(); body = text ? JSON.parse(text) : {} } catch { return new Response('Bad JSON', { status: 400 }) }
  const base = roomBase(body?.room)
  if (!base) return new Response('Bad room', { status: 400 })
  const store = getStore({ name: 'webrtc', consistency: 'strong' })
  const generation = crypto.randomUUID()
  // Publish the new generation before cleaning old candidate mailboxes.
  await store.setJSON(`${base}/generation.json`, generation)
  const cleanup = async () => {
    for await (const page of store.list({ prefix: `${base}/`, paginate: true })) {
      for (const { key } of page.blobs) {
        if (key === `${base}/generation.json` ||
            key.startsWith(`${base}/generations/${generation}/`)) continue
        // Concurrent resets must never lose data from the latest active generation.
        const active = await store.get(`${base}/generation.json`, { type: 'json' })
        if (active && key.startsWith(`${base}/generations/${active}/`)) continue
        await store.delete(key)
      }
    }
  }
  if (typeof context?.waitUntil === 'function') context.waitUntil(cleanup())
  else await cleanup() // in-memory test fixture
  return new Response(JSON.stringify({ generation }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
