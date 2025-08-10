import { getStore } from '@netlify/blobs'
import type { Handler } from '@netlify/functions'

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }
  const role = event.queryStringParameters?.role
  if (!(role === 'a' || role === 'b')) return { statusCode: 400, body: 'Bad role' }

  const store = getStore({ name: 'webrtc', consistency: 'strong' })
  const base = 'room/default'
  const peer = role === 'a' ? 'b' : 'a'

  const offer  = await store.getJSON(`${base}/offer.json`)
  const answer = await store.getJSON(`${base}/answer.json`)

  const list = await store.list({ prefix: `${base}/candidates-${peer}/` })
  const candidates: any[] = []
  for (const { key } of list.blobs) {
    const c = await store.getJSON(key)
    if (c) candidates.push(c)
    await store.delete(key) // pop after read
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ offer, answer, candidates }),
  }
}
