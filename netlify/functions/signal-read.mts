import { getStore } from '@netlify/blobs'
import type { Context } from '@netlify/functions'
import { roomBase } from '../lib/room'

export default async (req: Request, _context: Context) => {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
  const url = new URL(req.url)
  const role = url.searchParams.get('role')
  if (!(role === 'a' || role === 'b')) return new Response('Bad role', { status: 400 })

  const base = roomBase(url.searchParams.get('room') ?? undefined)
  if (!base) return new Response('Bad room', { status: 400 })
  const store = getStore({ name: 'webrtc', consistency: 'strong' })
  const peer = role === 'a' ? 'b' : 'a'

  const generation = await store.get(`${base}/generation.json`, { type: 'json' })
  const signalBase = generation ? `${base}/generations/${generation}` : base
  const offer  = await store.get(`${signalBase}/offer.json`,  { type: 'json' })
  const answer = await store.get(`${signalBase}/answer.json`, { type: 'json' })

  const list = await store.list({ prefix: `${signalBase}/candidates-${peer}/` })
  const candidates: any[] = []
  for (const { key } of list.blobs) {
    const c = await store.get(key, { type: 'json' })
    if (c) candidates.push(c)
    await store.delete(key) // pop after read
  }

  return new Response(JSON.stringify({ generation, offer, answer, candidates }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  })
}
