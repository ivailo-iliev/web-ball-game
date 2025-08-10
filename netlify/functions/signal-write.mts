import { getStore } from '@netlify/blobs'
import type { Context } from '@netlify/functions'

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  const store = getStore({ name: 'webrtc', consistency: 'strong' })
  const base = 'room/default'

  try {
    const { kind, role, data } = await req.json() as { kind: string; role?: 'a'|'b'; data: any }
    if (!kind || !data) return new Response('Bad Request', { status: 400 })

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
