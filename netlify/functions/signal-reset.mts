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
  const list = await store.list({ prefix: `${base}/` })
  for (const { key } of list.blobs) await store.delete(key)
  return new Response('OK', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } })
}
