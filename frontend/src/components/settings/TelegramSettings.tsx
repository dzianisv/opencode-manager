import { useState, useEffect, useCallback } from 'react'
import { Loader2, Plus, Trash2, Bot, Users, MessageSquare } from 'lucide-react'
import { telegramApi } from '@/api/telegram'
import type { TelegramStatus, TelegramSession } from '@/api/telegram'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { showToast } from '@/lib/toast'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

export function TelegramSettings() {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [allowlist, setAllowlist] = useState<string[]>([])
  const [sessions, setSessions] = useState<TelegramSession[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [botToken, setBotToken] = useState('')
  const [newAllowId, setNewAllowId] = useState('')
  const [isUpdating, setIsUpdating] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const [statusData, allowlistData, sessionsData] = await Promise.all([
        telegramApi.getStatus(),
        telegramApi.getAllowlist(),
        telegramApi.getSessions()
      ])
      setStatus(statusData)
      setAllowlist(allowlistData)
      setSessions(sessionsData)
    } catch (error) {
      console.error('Failed to fetch telegram data:', error)
      showToast.error('Failed to load Telegram settings')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleStartBot = async () => {
    if (!botToken && !status?.running) {
      showToast.error('Please enter a bot token')
      return
    }

    setIsUpdating(true)
    try {
      const result = await telegramApi.startBot(botToken)
      setStatus(result.status)
      setBotToken('') // Clear token after success for security
      showToast.success('Telegram bot started successfully')
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : 'Failed to start bot')
    } finally {
      setIsUpdating(false)
    }
  }

  const handleStopBot = async () => {
    setIsUpdating(true)
    try {
      await telegramApi.stopBot()
      setStatus(prev => prev ? { ...prev, running: false } : null)
      showToast.success('Telegram bot stopped')
    } catch (error) {
      console.error('Stop bot error:', error)
      showToast.error('Failed to stop bot')
    } finally {
      setIsUpdating(false)
    }
  }

  const handleAddAllowlist = async () => {
    if (!newAllowId.trim()) return

    try {
      await telegramApi.addToAllowlist(newAllowId)
      setAllowlist(prev => [...prev, newAllowId])
      setNewAllowId('')
      showToast.success('User added to allowlist')
    } catch (error) {
      console.error('Add allowlist error:', error)
      showToast.error('Failed to add user to allowlist')
    }
  }

  const handleRemoveAllowlist = async (chatId: string) => {
    try {
      await telegramApi.removeFromAllowlist(chatId)
      setAllowlist(prev => prev.filter(id => id !== chatId))
      showToast.success('User removed from allowlist')
    } catch (error) {
      console.error('Remove allowlist error:', error)
      showToast.error('Failed to remove user from allowlist')
    }
  }

  const handleKillSession = async (chatId: string) => {
    try {
      await telegramApi.deleteSession(chatId)
      setSessions(prev => prev.filter(s => s.chatId !== chatId))
      showToast.success('Session terminated')
    } catch (error) {
      console.error('Kill session error:', error)
      showToast.error('Failed to terminate session')
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Telegram Integration</h2>
        <Badge variant={status?.running ? "default" : "secondary"} className={status?.running ? "bg-green-500 hover:bg-green-600" : ""}>
          {status?.running ? "Running" : "Stopped"}
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Bot className="w-4 h-4" />
            Bot Configuration
          </CardTitle>
          <CardDescription>
            Configure your Telegram bot token to enable remote access via Telegram.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bot-token">Bot Token</Label>
            <div className="flex gap-2">
              <Input
                id="bot-token"
                type="password"
                placeholder={status?.running ? "••••••••••••••••" : "Enter bot token from @BotFather"}
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                disabled={isUpdating}
              />
              {status?.running ? (
                <Button variant="destructive" onClick={handleStopBot} disabled={isUpdating}>
                  {isUpdating ? <Loader2 className="w-4 h-4 animate-spin" /> : "Stop"}
                </Button>
              ) : (
                <Button onClick={handleStartBot} disabled={isUpdating || !botToken}>
                  {isUpdating ? <Loader2 className="w-4 h-4 animate-spin" /> : "Start"}
                </Button>
              )}
            </div>
            {status?.botInfo && (
              <div className="text-sm text-muted-foreground mt-2">
                Connected as: <span className="font-medium text-foreground">@{status.botInfo.username}</span> ({status.botInfo.first_name})
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="w-4 h-4" />
            Access Control (Allowlist)
          </CardTitle>
          <CardDescription>
            Only users with these Chat IDs can interact with your bot.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="Enter Chat ID"
              value={newAllowId}
              onChange={(e) => setNewAllowId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddAllowlist()}
            />
            <Button variant="secondary" onClick={handleAddAllowlist} disabled={!newAllowId}>
              <Plus className="w-4 h-4" />
            </Button>
          </div>
          
          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Chat ID</TableHead>
                  <TableHead className="w-[100px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allowlist.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={2} className="text-center text-muted-foreground h-24">
                      No allowed users. Bot will reject all messages.
                    </TableCell>
                  </TableRow>
                ) : (
                  allowlist.map((id) => (
                    <TableRow key={id}>
                      <TableCell className="font-mono">{id}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" onClick={() => handleRemoveAllowlist(id)}>
                          <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {status?.running && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <MessageSquare className="w-4 h-4" />
              Active Sessions
            </CardTitle>
            <CardDescription>
              Currently active chat sessions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Chat ID</TableHead>
                    <TableHead>Messages</TableHead>
                    <TableHead>Last Active</TableHead>
                    <TableHead className="w-[100px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground h-24">
                        No active sessions
                      </TableCell>
                    </TableRow>
                  ) : (
                    sessions.map((session) => (
                      <TableRow key={session.chatId}>
                        <TableCell className="font-mono">{session.chatId}</TableCell>
                        <TableCell>{session.messages}</TableCell>
                        <TableCell>{new Date(session.lastActivity).toLocaleString()}</TableCell>
                        <TableCell>
                          <Button variant="ghost" size="icon" onClick={() => handleKillSession(session.chatId)} title="End Session">
                            <XCircle className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function XCircle({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </svg>
  )
}
