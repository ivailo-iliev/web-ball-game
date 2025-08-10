import { getStore } from '@netlify/blobs'
import type { Handler } from '@netlify/functions'

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }
  const store = getStore({ name: 'webrtc', consistency: 'strong' })
  const list = await store.list({ prefix: 'room/default/' })
  for (const { key } of list.blobs) {
    await store.delete(key)
  }
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
    body: 'OK',
  }
}
