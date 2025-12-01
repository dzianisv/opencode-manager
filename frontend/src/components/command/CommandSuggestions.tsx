import { useEffect, useRef } from 'react'
import { Command } from 'lucide-react'
import type { components } from '@/api/opencode-types'

type CommandType = components['schemas']['Command']

interface CommandSuggestionsProps {
  isOpen: boolean
  query: string
  commands: CommandType[]
  onSelect: (command: CommandType) => void
  onClose: () => void
  selectedIndex?: number
}

export function CommandSuggestions({
  isOpen,
  query,
  commands,
  onSelect,
  selectedIndex = 0
}: CommandSuggestionsProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const filteredCommands = commands.filter(command =>
    command.name.toLowerCase().includes(query.toLowerCase()) ||
    command.description?.toLowerCase().includes(query.toLowerCase())
  )

  

  

  // Scroll selected item into view
  useEffect(() => {
    if (!isOpen || !containerRef.current) return

    const selectedItem = containerRef.current.querySelector(`[data-selected="true"]`) as HTMLElement
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [selectedIndex, isOpen])

  if (!isOpen || filteredCommands.length === 0) {
    return null
  }

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-0 right-0 mb-2 z-50 bg-background border border-border rounded-lg shadow-lg max-h-64 overflow-y-auto"
    >
      <div className="p-1">
        {filteredCommands.map((command, index) => {
          const isSelected = index === selectedIndex
          const displayName = `/${command.name}`
          
          return (
            <div
              key={command.name}
              data-selected={isSelected}
              className={`px-3 py-2 cursor-pointer rounded-md transition-colors flex items-center gap-2 ${
                isSelected 
                  ? 'bg-primary/20 text-foreground' 
                  : 'hover:bg-muted text-muted-foreground'
              }`}
              onClick={() => onSelect(command)}
              
            >
              <Command className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate">{displayName}</div>
                {command.description && (
                  <div className="text-xs text-muted-foreground truncate">{command.description}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      
      <div className="px-3 py-2 border-t border-border text-xs text-muted-foreground">
        <div className="flex items-center gap-4">
          <span>↑↓ Navigate</span>
          <span>↵ Select</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  )
}
