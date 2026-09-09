// The preview's "Threads" section: which BB threads have been started on this
// work item, and a form to start another.
//
// Plane has no field for a BB thread, so the link lives in this plugin's kv
// keyed by the work item id. The thread's title and status are read live, so a
// renamed or finished thread reads correctly here without a write to Plane.
import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { BoardBbProject, BoardLinkedThread, rpcContract } from "@/server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { formatDateTime } from "@/lib/plane-ui";
import { cn } from "@/lib/utils";

/** Threads that are done reading as quiet; anything live reads as active. */
const QUIET_STATUSES = new Set(["idle", "deleted"]);

function ThreadRow({
  thread,
  onOpen,
}: {
  thread: BoardLinkedThread;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        disabled={thread.status === "deleted"}
        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-muted disabled:opacity-60 disabled:hover:bg-transparent"
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            QUIET_STATUSES.has(thread.status) ? "bg-muted-foreground" : "bg-foreground",
          )}
        />
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{thread.status}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatDateTime(thread.createdAt)}
        </span>
      </button>
    </li>
  );
}

export function DelegateWorkItem({
  accountId,
  projectId,
  itemId,
}: {
  accountId: string;
  projectId: string;
  itemId: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();

  const [threads, setThreads] = useState<BoardLinkedThread[] | null>(null);
  const [bbProjects, setBbProjects] = useState<BoardBbProject[] | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [bbProjectId, setBbProjectId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadThreads = useCallback(() => {
    rpc.call("item_threads", { itemId }).then(
      (result) => setThreads(result.threads),
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, itemId]);

  useEffect(() => {
    setThreads(null);
    setIsComposing(false);
    setError(null);
    loadThreads();
  }, [loadThreads]);

  // The BB project list is only needed once the form is open, and it is the
  // same for every work item, so it is fetched lazily and kept.
  useEffect(() => {
    if (!isComposing || bbProjects !== null) return;
    rpc.call("bb_projects", null).then(
      (result) => {
        setBbProjects(result.projects);
        setBbProjectId((current) => (current === "" ? (result.projects[0]?.id ?? "") : current));
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, isComposing, bbProjects]);

  const start = () => {
    if (bbProjectId === "") return;
    setIsStarting(true);
    setError(null);
    rpc
      .call("item_delegate", { accountId, projectId, itemId, bbProjectId, instructions })
      .then(
        (result) => {
          setIsStarting(false);
          setIsComposing(false);
          setInstructions("");
          setThreads((live) => [result.thread, ...(live ?? [])]);
          navigate.toThread(result.thread.threadId);
        },
        (cause) => {
          setIsStarting(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        },
      );
  };

  return (
    <div className="py-3">
      <h3 className="text-xs font-medium text-muted-foreground">
        Threads
        {threads === null ? "" : ` (${threads.length})`}
      </h3>

      {threads === null ? (
        <p className="mt-1.5 text-sm text-muted-foreground">Loading…</p>
      ) : threads.length === 0 ? (
        <p className="mt-1.5 text-sm text-muted-foreground">
          No agent has been started on this work item.
        </p>
      ) : (
        <ul className="mt-1.5">
          {threads.map((thread) => (
            <ThreadRow
              key={thread.threadId}
              thread={thread}
              onOpen={() => navigate.toThread(thread.threadId)}
            />
          ))}
        </ul>
      )}

      {error === null ? null : (
        <p role="alert" className="mt-1.5 text-sm text-destructive">
          {error}
        </p>
      )}

      {isComposing ? (
        <div className="mt-2 space-y-2 rounded border border-border p-2">
          <label className="block text-xs text-muted-foreground">
            BB project
            <select
              value={bbProjectId}
              onChange={(event) => setBbProjectId(event.target.value)}
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
            >
              {bbProjects === null ? (
                <option value="">Loading…</option>
              ) : (
                bbProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="block text-xs text-muted-foreground">
            What should the agent do? (optional)
            <textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={3}
              placeholder="Defaults to: read the ticket, then start."
              className="mt-1 w-full resize-y rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
            />
          </label>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={start}
              disabled={isStarting || bbProjectId === ""}
            >
              {isStarting ? "Starting…" : "Start thread"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setIsComposing(false)}
              disabled={isStarting}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => setIsComposing(true)}
        >
          <Icon name="Bot" className="size-3.5" />
          Delegate to an agent
        </Button>
      )}
    </div>
  );
}
