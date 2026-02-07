type SessionKeyedItem = { id: string; sessionID: string }
type SessionKeyedState<T> = Record<string, T[]>
type StateSetter<T> = React.Dispatch<React.SetStateAction<SessionKeyedState<T>>>

export function addToSessionKeyedState<T extends SessionKeyedItem>(
  setter: StateSetter<T>,
  item: T
): void {
  setter(prev => {
    const sessionID = item.sessionID
    const existing = prev[sessionID] ?? []
    const existingIndex = existing.findIndex(i => i.id === item.id)
    
    if (existingIndex >= 0) {
      const updated = [...existing]
      updated[existingIndex] = item
      return { ...prev, [sessionID]: updated }
    }
    return { ...prev, [sessionID]: [...existing, item] }
  })
}

export function removeFromSessionKeyedState<T extends SessionKeyedItem>(
  setter: StateSetter<T>,
  id: string,
  sessionID?: string
): void {
  setter(prev => {
    if (sessionID) {
      const existing = prev[sessionID]
      if (!existing) return prev
      const filtered = existing.filter(i => i.id !== id)
      if (filtered.length === 0) {
        const { [sessionID]: _removed, ...rest } = prev
      void _removed
        return rest
      }
      return { ...prev, [sessionID]: filtered }
    }
    
    const newState: SessionKeyedState<T> = {}
    for (const [sid, items] of Object.entries(prev)) {
      const filtered = items.filter(i => i.id !== id)
      if (filtered.length > 0) newState[sid] = filtered
    }
    return newState
  })
}
