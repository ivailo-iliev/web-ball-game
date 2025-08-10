import { getStore } from '@netlify/blobs'
import type { Context } from '@netlify/functions'

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  const store = getStore({ name: 'webrtc', consistency: 'strong' })
  const list = await store.list({ prefix: 'room/default/' })
  for (const { key } of list.blobs) await store.delete(key)
  return new Response('OK', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } })
}
