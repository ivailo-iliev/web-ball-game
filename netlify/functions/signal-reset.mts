import { getStore } from '@netlify/blobs'
import type { Context } from '@netlify/functions'
import { roomBase } from '../lib/room'

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  let body
  try { const text = await req.text(); body = text ? JSON.parse(text) : {} } catch { return new Response('Bad JSON', { status: 400 }) }
  const base = roomBase(body?.room)
  if (!base) return new Response('Bad room', { status: 400 })
  const store = getStore({ name: 'webrtc', consistency: 'strong' })
  const generation = crypto.randomUUID()
  // Snapshot old keys before publishing the new generation. Do not delete writes
  // for the new generation (or the pointer) that arrive while cleanup runs.
  const keys: string[] = []
  for await (const page of store.list({ prefix: `${base}/`, paginate: true })) {
    for (const { key } of page.blobs) if (key !== `${base}/generation.json`) keys.push(key)
  }
  await store.setJSON(`${base}/generation.json`, generation)
  for (const key of keys) await store.delete(key)
  return new Response(JSON.stringify({ generation }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
