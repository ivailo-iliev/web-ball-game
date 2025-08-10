import { getStore } from '@netlify/blobs'
import type { Context } from '@netlify/functions'

export default async (req: Request, _context: Context) => {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
  const url = new URL(req.url)
  const role = url.searchParams.get('role')
  if (!(role === 'a' || role === 'b')) return new Response('Bad role', { status: 400 })

  const store = getStore({ name: 'webrtc', consistency: 'strong' })
  const base = 'room/default'
  const peer = role === 'a' ? 'b' : 'a'

  const offer  = await store.get(`${base}/offer.json`,  { type: 'json' })
  const answer = await store.get(`${base}/answer.json`, { type: 'json' })

  const list = await store.list({ prefix: `${base}/candidates-${peer}/` })
  const candidates: any[] = []
  for (const { key } of list.blobs) {
    const c = await store.get(key, { type: 'json' })
    if (c) candidates.push(c)
    await store.delete(key) // pop after read
  }

  return new Response(JSON.stringify({ offer, answer, candidates }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  })
}
