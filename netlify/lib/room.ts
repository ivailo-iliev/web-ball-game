// Shared room validation. An omitted room preserves the original gameplay keys.
export function roomBase(room: unknown): string | null {
  if (room === undefined) return 'room/default'
  return typeof room === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(room)
    ? `room/${room}` : null
}
