import { getStore } from '@netlify/blobs'
import type { Context } from '@netlify/functions'
import { roomBase } from '../lib/room'

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  let body
  try { body = await req.json() } catch { return new Response('Bad JSON', { status: 400 }) }
  const base = roomBase(body?.room)
  if (!base) return new Response('Bad room', { status: 400 })
  const { kind, role, data } = body || {}
  if (!kind || !data || (kind === 'candidate' && role !== 'a' && role !== 'b')) {
    return new Response('Bad Request', { status: 400 })
  }
  const store = getStore({ name: 'webrtc', consistency: 'strong' })
  try {
    if (kind === 'offer' || kind === 'answer') {
      await store.setJSON(`${base}/${kind}.json`, data)
    } else if (kind === 'candidate') {
      const id = crypto.randomUUID()
      await store.setJSON(`${base}/candidates-${role}/${id}.json`, data)
    } else {
      return new Response('Unknown kind', { status: 400 })
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    })
  } catch {
    return new Response('Error', { status: 500 })
  }
}
