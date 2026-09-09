// `::plane{key="GA-724"}` in an assistant message, rendered as a live card.
//
// An agent that mentions a ticket writes the directive instead of the bare key,
// and the reader gets the current title, state and priority — not whatever they
// were when the message was written. Clicking opens the board at that item.
import { useEffect, useState } from "react";
import {
  useBbNavigate,
  useRpc,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import type { BoardCard, rpcContract } from "@/server";
import { Icon } from "@/components/ui/icon";
import { dotStyle, priorityClass } from "@/lib/plane-ui";
import { cn } from "@/lib/utils";

/** The panel path the board is registered under; kept in step with app.tsx. */
const PANEL_PATH = "plane";

type Status = "loading" | "ready" | "missing" | "failed";

export function WorkItemDirective({ attributes }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();

  const key = (attributes.key ?? "").trim();
  const fallbackTitle = (attributes.title ?? "").trim();

  const [card, setCard] = useState<BoardCard | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    if (key === "") {
      setStatus("missing");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    rpc.call("item_by_key", { key }).then(
      (result) => {
        if (cancelled) return;
        setCard(result.card);
        setStatus(result.card === null ? "missing" : "ready");
      },
      () => {
        if (!cancelled) setStatus("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, key]);

  // A key that does not resolve — no account configured, a different
  // workspace, a deleted item — still has to read as the ticket it names.
  if (status !== "ready" || card === null) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded border border-border px-1.5 py-0.5 align-middle text-sm">
        <span className="font-mono text-xs text-muted-foreground">
          {key === "" ? "::plane" : key}
        </span>
        {fallbackTitle === "" ? null : <span>{fallbackTitle}</span>}
        {status === "loading" ? (
          <span className="text-xs text-muted-foreground">…</span>
        ) : null}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() =>
        navigate.toPluginPanel(PANEL_PATH, {
          subPath: `${card.accountId}/${card.projectId}/${card.itemId}`,
        })
      }
      title={`Open ${card.key} on the board`}
      className="my-1 flex w-full items-center gap-2 rounded border border-border px-2.5 py-2 text-left hover:border-foreground/40 hover:bg-muted/50"
    >
      {card.stateColor === null ? null : (
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full bg-muted-foreground"
          style={dotStyle(card.stateColor)}
        />
      )}
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{card.key}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{card.name}</span>
      {card.stateName === null ? null : (
        <span className="shrink-0 text-xs text-muted-foreground">{card.stateName}</span>
      )}
      <span
        className={cn(
          "shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
          priorityClass(card.priority),
        )}
      >
        {card.priority}
      </span>
      <Icon name="ArrowUpRight" className="size-3 shrink-0 text-muted-foreground" />
    </button>
  );
}
