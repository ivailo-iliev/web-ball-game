import { getStore } from '@netlify/blobs'
import type { Handler } from '@netlify/functions'

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }
  const store = getStore({ name: 'webrtc', consistency: 'strong' })
  const base = 'room/default'
  try {
    const { kind, role, data } = JSON.parse(event.body || '{}')
    if (!kind || !data) return { statusCode: 400, body: 'Bad Request' }

    if (kind === 'offer' || kind === 'answer') {
      await store.setJSON(`${base}/${kind}.json`, data)
    } else if (kind === 'candidate') {
      const id = crypto.randomUUID()
      await store.setJSON(`${base}/candidates-${role}/${id}.json`, data)
    } else {
      return { statusCode: 400, body: 'Unknown kind' }
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({ ok: true }),
    }
  } catch (e) {
    return { statusCode: 500, body: 'Error' }
  }
}
