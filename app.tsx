// bb-plugin-plane-board — frontend entry.
//
// A Plane kanban board as a BB nav panel. Every Plane call goes through the
// backend's RPC contract, so an API key stays on the server. The selected
// account and project live in the panel's subPath, which makes a board a
// shareable link (/plugins/plane-board/plane/<account-id>/<project-id>).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  BoardAccount,
  BoardLabel,
  BoardMember,
  BoardProject,
  BoardState,
  BoardWorkItem,
  rpcContract,
} from "./server";
import { Board } from "@/components/board";
import { WorkItemPreview } from "@/components/work-item-preview";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const PANEL_PATH = "plane";

/** A board refetch waits this long for more signals, so a burst is one load. */
const REFETCH_DEBOUNCE_MS = 250;

interface BoardData {
  project: BoardProject;
  states: BoardState[];
  labels: BoardLabel[];
  members: BoardMember[];
  items: BoardWorkItem[];
  truncated: boolean;
}

/** `<account-id>/<project-id>`; a lone segment is a project, as older links used. */
function parseSubPath(subPath: string): { accountId: string | null; projectId: string | null } {
  const segments = subPath.split("/").filter((segment) => segment !== "");
  if (segments.length >= 2) return { accountId: segments[0], projectId: segments[1] };
  if (segments.length === 1) return { accountId: null, projectId: segments[0] };
  return { accountId: null, projectId: null };
}

/** The account to show: the one in the URL, then the first ready one, then the first. */
function pickAccount(accounts: BoardAccount[], wanted: string | null): BoardAccount | null {
  if (accounts.length === 0) return null;
  const fromPath = accounts.find((account) => account.id === wanted);
  if (fromPath !== undefined) return fromPath;
  return accounts.find((account) => account.ready) ?? accounts[0];
}

/**
 * The project to show: the one in the URL when it still exists, then the
 * account's default (by identifier, name, or id), then the first.
 */
function pickProject(
  projects: BoardProject[],
  wanted: string | null,
  defaultProject: string,
): BoardProject | null {
  if (projects.length === 0) return null;
  const fromPath = projects.find((project) => project.id === wanted);
  if (fromPath !== undefined) return fromPath;
  const needle = defaultProject.toLowerCase();
  const fromSetting =
    needle === ""
      ? undefined
      : projects.find(
          (project) =>
            project.id === defaultProject ||
            project.identifier.toLowerCase() === needle ||
            project.name.toLowerCase() === needle,
        );
  return fromSetting ?? projects[0];
}

function Notice({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "error";
  children: React.ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "mx-4 rounded-lg border border-dashed px-4 py-6 text-center text-sm md:mx-5",
        tone === "error"
          ? "border-destructive/40 text-destructive"
          : "border-border text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

function BoardPage({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();

  const [accounts, setAccounts] = useState<BoardAccount[] | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [projects, setProjects] = useState<BoardProject[] | null>(null);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [movingItemId, setMovingItemId] = useState<string | null>(null);
  const [previewItemId, setPreviewItemId] = useState<string | null>(null);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const wanted = useMemo(() => parseSubPath(subPath), [subPath]);
  const account = useMemo(
    () => (accounts === null ? null : pickAccount(accounts, wanted.accountId)),
    [accounts, wanted.accountId],
  );
  const accountId = account?.id ?? null;
  const accountReady = account?.ready ?? false;

  const project = useMemo(
    () =>
      projects === null
        ? null
        : pickProject(projects, wanted.projectId, account?.defaultProject ?? ""),
    [projects, wanted.projectId, account?.defaultProject],
  );
  const projectId = project?.id ?? null;

  const loadConfig = useCallback(() => {
    rpc.call("config_read").then((config) => {
      setAccounts(config.accounts);
      setConfigError(config.error);
    }, report);
  }, [rpc, report]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Projects belong to an account, so they are reloaded when it changes and
  // never mixed between two of them.
  useEffect(() => {
    if (accountId === null || !accountReady) {
      setProjects(null);
      return;
    }
    let cancelled = false;
    rpc.call("projects_list", { accountId }).then(
      (result) => {
        if (!cancelled) {
          setProjects(result.projects);
          setError(null);
        }
      },
      (cause) => {
        if (!cancelled) {
          setProjects([]);
          report(cause);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, accountId, accountReady, report]);

  // Only the newest board request may write state. Without this, two overlapping
  // loads can land out of order and the board visibly swaps twice.
  const requestSeq = useRef(0);

  const loadBoard = useCallback(
    (showSpinner: boolean) => {
      if (accountId === null || projectId === null) return;
      const seq = ++requestSeq.current;
      if (showSpinner) setIsRefreshing(true);
      rpc.call("board_load", { accountId, projectId }).then(
        (data) => {
          if (seq !== requestSeq.current) return;
          setBoard(data);
          setError(null);
          setIsRefreshing(false);
        },
        (cause) => {
          if (seq !== requestSeq.current) return;
          report(cause);
          setIsRefreshing(false);
        },
      );
    },
    [rpc, accountId, projectId, report],
  );

  // Clear the board only when the board being shown actually changes, so a
  // refetch updates in place instead of blanking the columns.
  const shownKey = accountId === null || projectId === null ? null : `${accountId}/${projectId}`;
  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    if (shownKey === null) return;
    if (loadedKey.current !== shownKey) {
      loadedKey.current = shownKey;
      setBoard(null);
      setPreviewItemId(null);
    }
    loadBoard(false);
  }, [shownKey, loadBoard]);

  // Coalesce signals: the settings form autosaves as it is typed in, and a
  // write from another window can arrive alongside one of our own.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefetch = useCallback((run: () => void) => {
    if (refetchTimer.current !== null) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      run();
    }, REFETCH_DEBOUNCE_MS);
  }, []);
  useEffect(
    () => () => {
      if (refetchTimer.current !== null) clearTimeout(refetchTimer.current);
    },
    [],
  );

  // server.ts publishes after every write, so a move made in another window (or
  // by an agent) lands here too.
  useRealtime("board-changed", (payload) => {
    const changed = (payload as { projectId?: string | null }).projectId ?? null;
    if (changed === null || changed === projectId) scheduleRefetch(() => loadBoard(false));
  });

  // A connection changed. Re-read the accounts; the board reloads only if the
  // account or project it is showing actually moved.
  useRealtime("config-changed", () => {
    scheduleRefetch(loadConfig);
  });

  const move = (itemId: string, stateId: string) => {
    if (board === null || accountId === null || projectId === null) return;
    const current = board.items.find((item) => item.id === itemId);
    if (current === undefined || current.stateId === stateId) return;
    const previous = board.items;
    setMovingItemId(itemId);
    setBoard({
      ...board,
      items: previous.map((item) => (item.id === itemId ? { ...item, stateId } : item)),
    });
    rpc.call("item_move", { accountId, projectId, itemId, stateId }).then(
      (updated) => {
        setMovingItemId(null);
        setError(null);
        setBoard((live) =>
          live === null
            ? live
            : {
                ...live,
                items: live.items.map((item) => (item.id === itemId ? updated : item)),
              },
        );
      },
      (cause) => {
        setMovingItemId(null);
        report(cause);
        setBoard((live) => (live === null ? live : { ...live, items: previous }));
      },
    );
  };

  const create = (stateId: string, name: string) => {
    if (accountId === null || projectId === null) return;
    rpc.call("item_create", { accountId, projectId, stateId, name }).then((item) => {
      setError(null);
      setBoard((live) => (live === null ? live : { ...live, items: [item, ...live.items] }));
    }, report);
  };

  const goTo = (nextAccountId: string, nextProjectId: string) =>
    navigate.toPluginPanel(PANEL_PATH, {
      subPath: `${nextAccountId}/${nextProjectId}`,
      replace: true,
    });

  const statesById = useMemo(
    () => new Map((board?.states ?? []).map((state) => [state.id, state])),
    [board],
  );
  const labelsById = useMemo(
    () => new Map((board?.labels ?? []).map((label) => [label.id, label])),
    [board],
  );
  const membersById = useMemo(
    () => new Map((board?.members ?? []).map((member) => [member.id, member])),
    [board],
  );

  // The preview reads the live card, so a move or a refetch updates it in
  // place; an item that leaves the board closes it.
  const previewItem =
    previewItemId === null
      ? null
      : (board?.items.find((item) => item.id === previewItemId) ?? null);

  // Render nothing until the accounts are known. Guessing produces a flash of
  // board chrome that is then replaced by the setup notice, or the reverse.
  if (accounts === null) return null;

  if (configError !== null) {
    return (
      <div className="pt-3 md:pt-4">
        <Notice tone="error">{configError}</Notice>
      </div>
    );
  }

  if (account === null || !accounts.some((candidate) => candidate.ready)) {
    return (
      <div className="h-full min-h-0 overflow-y-auto pt-3 md:pt-4">
        <Notice>
          <p className="text-foreground">Connect a Plane workspace to see a board.</p>
          <p className="mt-2">
            Open <strong>Extensions → Plugins → Plane Board</strong>, put your workspace
            slug and server URL in <strong>Accounts</strong>, and fill in the matching{" "}
            <strong>API key</strong> field (Plane → Profile settings → Personal access
            tokens). Leave the server URL at <code>https://api.plane.so</code> for Plane
            Cloud, or point it at your self-hosted instance.
          </p>
          <p className="mt-2">
            Adding a second account? Save it in <strong>Accounts</strong>, then run{" "}
            <code>bb plugin reload plane-board</code> so its own API key field appears.
          </p>
        </Notice>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 pb-3 pt-3 md:px-5 md:pt-4">
        {accounts.length > 1 ? (
          <select
            aria-label="Plane account"
            value={account.id}
            onChange={(event) => goTo(event.target.value, "")}
            className="h-8 max-w-40 rounded-md border border-border bg-card px-2 text-sm text-foreground"
          >
            {accounts.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
                {candidate.ready ? "" : " (not configured)"}
              </option>
            ))}
          </select>
        ) : null}
        <select
          aria-label="Project"
          value={project?.id ?? ""}
          disabled={projects === null || projects.length === 0}
          onChange={(event) => goTo(account.id, event.target.value)}
          className="h-8 max-w-64 rounded-md border border-border bg-card px-2 text-sm text-foreground"
        >
          {projects === null ? <option value="">Loading…</option> : null}
          {(projects ?? []).map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.identifier} · {candidate.name}
            </option>
          ))}
        </select>
        {board === null ? null : (
          <span className="text-xs text-muted-foreground">
            {board.items.length} work item{board.items.length === 1 ? "" : "s"}
            {board.truncated ? " (most recently updated)" : ""}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-7 text-muted-foreground hover:text-foreground"
          aria-label="Refresh board"
          disabled={projectId === null || isRefreshing}
          onClick={() => loadBoard(true)}
        >
          <Icon
            name="ArrowReloadHorizontal"
            className={cn("size-4", isRefreshing && "animate-spin")}
          />
        </Button>
      </div>

      {error === null ? null : (
        <div className="pb-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {!accountReady ? (
        <Notice>
          <strong>{account.label}</strong> has no API key or workspace slug yet.
        </Notice>
      ) : board !== null ? (
        <Board
          states={board.states}
          items={board.items}
          identifier={board.project.identifier}
          labels={labelsById}
          members={membersById}
          movingItemId={movingItemId}
          onMove={move}
          onCreate={create}
          onOpenItem={(item) => setPreviewItemId(item.id)}
        />
      ) : error !== null ? null : (
        <Notice>
          {projects !== null && projects.length === 0
            ? "This workspace has no projects yet."
            : "Loading the board…"}
        </Notice>
      )}

      {board !== null && previewItem !== null && accountId !== null ? (
        <WorkItemPreview
          accountId={accountId}
          projectId={board.project.id}
          identifier={board.project.identifier}
          item={previewItem}
          states={statesById}
          labels={labelsById}
          members={membersById}
          onClose={() => setPreviewItemId(null)}
        />
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "plane-board",
    title: "Plane",
    icon: "Columns2",
    path: PANEL_PATH,
    component: BoardPage,
  });
});
