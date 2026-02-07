import { useState, useMemo } from "react";
import { useSessions, useDeleteSession } from "@/hooks/useOpenCode";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { SessionCard } from "./SessionCard";

interface SessionListProps {
  opcodeUrl: string;
  directory?: string;
  activeSessionID?: string;
  onSelectSession: (sessionID: string) => void;
  repoId?: number;
}

function getShortSessionId(id: string): string {
  if (id.startsWith('ses_')) {
    return id.slice(4, 12)
  }
  return id.slice(0, 8)
}

interface SessionItemProps {
  session: {
    id: string
    title?: string
    time: { created: number; updated: number }
  }
  directory?: string
  isSelected: boolean
  isActive: boolean
  onSelect: () => void
  onToggle: (checked: boolean) => void
  onDelete: (e: React.MouseEvent<HTMLButtonElement>) => void
}

function SessionItem({ session, directory, isSelected, isActive, onSelect, onToggle, onDelete }: SessionItemProps) {
  const { data: firstMessage } = useFirstMessage(session.id, directory)
  
  return (
    <Card
      className={`p-3 cursor-pointer transition-all ${
        isSelected
          ? "border-blue-500 shadow-lg shadow-blue-900/30 dark:shadow-blue-900/30 bg-accent"
          : isActive
            ? "bg-accent border-border"
            : "bg-card border-border hover:bg-accent hover:border-border"
      } hover:shadow-lg`}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <Checkbox
            checked={isSelected}
            onCheckedChange={(checked) => onToggle(checked === true)}
            onClick={(e) => e.stopPropagation()}
            className="w-5 h-5 flex-shrink-0 mt-0.5"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="flex items-center gap-1 text-xs text-muted-foreground font-mono">
                <Hash className="w-3 h-3" />
                {getShortSessionId(session.id)}
              </span>
            </div>
            {firstMessage && (
              <p className="text-sm mt-1 line-clamp-2 text-foreground">
                {firstMessage}
              </p>
            )}
            {!firstMessage && session.title && session.title !== 'Untitled Session' && !session.title.startsWith('New session -') && (
              <p className="text-sm mt-1 line-clamp-1 text-muted-foreground italic">
                {session.title}
              </p>
            )}
            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatDistanceToNow(new Date(session.time.updated), {
                  addSuffix: true,
                })}
              </span>
            </div>
          </div>
        </div>
        <button
          className="h-6 w-6 p-0 text-foreground hover:text-red-600 dark:hover:text-red-400 bg-transparent border-none cursor-pointer"
          onClick={onDelete}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </Card>
  )
}

export const SessionList = ({
  opcodeUrl,
  directory,
  activeSessionID,
  onSelectSession,
}: SessionListProps) => {
  const { data: sessions, isLoading } = useSessions(opcodeUrl, directory);
  const deleteSession = useDeleteSession(opcodeUrl, directory);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState<
    string | string[] | null
  >(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(
    new Set(),
  );

  const filteredSessions = useMemo(() => {
    if (!sessions) return [];

    let filtered = sessions.filter((session) => {
      if (session.parentID) return false;
      if (directory && session.directory && session.directory !== directory) return false;
      return true;
    });

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((session) =>
        (session.title || "Untitled Session").toLowerCase().includes(query),
      );
    }

    return filtered.sort((a, b) => b.time.updated - a.time.updated);
  }, [sessions, searchQuery, directory]);

  const todaySessions = useMemo(() => {
    if (!filteredSessions) return [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return filteredSessions.filter((session) => new Date(session.time.updated) >= today);
  }, [filteredSessions]);

  const olderSessions = useMemo(() => {
    if (!filteredSessions) return [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return filteredSessions.filter((session) => new Date(session.time.updated) < today);
  }, [filteredSessions]);

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading sessions...</div>;
  }

  if (!sessions || sessions.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No sessions yet. Create one to get started.
      </div>
    );
  }

  const handleDelete = (
    sessionId: string,
    e: React.MouseEvent<HTMLButtonElement>,
  ) => {
    e.stopPropagation();
    setSessionToDelete(sessionId);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (sessionToDelete) {
      await deleteSession.mutateAsync(sessionToDelete);
      setDeleteDialogOpen(false);
      setSessionToDelete(null);
      setSelectedSessions(new Set());
    }
  };

  const cancelDelete = () => {
    setDeleteDialogOpen(false);
    setSessionToDelete(null);
    setSelectedSessions(new Set());
  };

  const toggleSessionSelection = (sessionId: string, selected: boolean) => {
    const newSelected = new Set(selectedSessions);
    if (selected) {
      newSelected.add(sessionId);
    } else {
      newSelected.delete(sessionId);
    }
    setSelectedSessions(newSelected);
  };

  const toggleSelectAll = () => {
    if (!filteredSessions || filteredSessions.length === 0) return;
    
    const allFilteredSelected = filteredSessions.every((session) =>
      selectedSessions.has(session.id),
    );

    if (allFilteredSelected) {
      setSelectedSessions(new Set());
    } else {
      const filteredIds = filteredSessions.map((s) => s.id);
      setSelectedSessions(new Set(filteredIds));
    }
  };

  const handleBulkDelete = () => {
    if (selectedSessions.size > 0) {
      setSessionToDelete(Array.from(selectedSessions));
      setDeleteDialogOpen(true);
    }
  };

  const handleDeleteAll = () => {
    if (!filteredSessions || filteredSessions.length === 0) return;
    setSessionToDelete(filteredSessions.map((s) => s.id));
    setDeleteDialogOpen(true);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 pt-2 flex-shrink-0">
        <ListToolbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          selectedCount={selectedSessions.size}
          totalCount={filteredSessions.length}
          allSelected={
            filteredSessions.length > 0 &&
            filteredSessions.every((session) => selectedSessions.has(session.id))
          }
          onToggleSelectAll={toggleSelectAll}
          onDelete={handleBulkDelete}
          onDeleteAll={handleDeleteAll}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-4 min-h-0 [mask-image:linear-gradient(to_bottom,transparent,black_16px,black)]">
        <div className="flex flex-col gap-2">
          {filteredSessions.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-4">
              No sessions found
            </div>
          ) : (
            <>
              {todaySessions.length > 0 && (
                <>
                  <div className="text-xs font-semibold text-muted-foreground px-1 py-2">
                    Today
                  </div>
                  {todaySessions.map((session) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      isSelected={selectedSessions.has(session.id)}
                      isActive={activeSessionID === session.id}
                      onSelect={onSelectSession}
                      onToggleSelection={(selected) => {
                        toggleSessionSelection(session.id, selected);
                      }}
                      onDelete={(e) => handleDelete(session.id, e)}
                    />
                  ))}
                </>
              )}

              {todaySessions.length > 0 && olderSessions.length > 0 && (
                <div className="my-2 h-px bg-border/80" />
              )}
              {olderSessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  isSelected={selectedSessions.has(session.id)}
                  isActive={activeSessionID === session.id}
                  onSelect={onSelectSession}
                  onToggleSelection={(selected) => {
                    toggleSessionSelection(session.id, selected);
                  }}
                  onDelete={(e) => handleDelete(session.id, e)}
                />
              ))}
            </>
          )}
        </div>
      </div>

      <DeleteSessionDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
        isDeleting={deleteSession.isPending}
        sessionCount={
          Array.isArray(sessionToDelete) ? sessionToDelete.length : 1
        }
      />
    </div>
  );
};
