// The work-item preview: Plane's peek view, as a BB dialog (a drawer on a
// compact viewport). Opening a card fetches the description, attachments and
// comments, which the board's list request does not carry.
import { useEffect, useState } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  BoardAttachment,
  BoardComment,
  BoardLabel,
  BoardMember,
  BoardState,
  BoardWorkItem,
  rpcContract,
} from "@/server";
import { DelegateWorkItem } from "@/components/delegate-work-item";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import {
  dotStyle,
  formatBytes,
  formatDate,
  formatDateTime,
  initials,
  labelStyle,
  priorityClass,
} from "@/lib/plane-ui";
import { cn } from "@/lib/utils";

interface Detail {
  item: BoardWorkItem;
  description: string;
  comments: BoardComment[];
  commentsAvailable: boolean;
  attachments: BoardAttachment[];
  attachmentsAvailable: boolean;
}

/** One label of the properties table: a fixed, quiet left column. */
function Property({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="w-24 shrink-0 pt-0.5 text-xs text-muted-foreground">{name}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-sm">
        {children}
      </div>
    </div>
  );
}

export function LabelPill({ label }: { label: BoardLabel }) {
  return (
    <span
      className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-foreground"
      style={labelStyle(label.color)}
    >
      <span
        aria-hidden
        className="size-1.5 rounded-full bg-muted-foreground"
        style={dotStyle(label.color)}
      />
      {label.name}
    </span>
  );
}

export function Avatar({ name }: { name: string }) {
  return (
    <span
      title={name}
      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground"
    >
      {initials(name)}
    </span>
  );
}

/**
 * One attached file. The url points at this plugin's own route rather than at
 * Plane: the browser has no API key, so it cannot fetch the asset directly.
 * Images show themselves; anything else is a named row that downloads.
 */
function Attachment({ attachment }: { attachment: BoardAttachment }) {
  const size = formatBytes(attachment.size);
  if (attachment.contentType.startsWith("image/")) {
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noreferrer"
        title={size === "" ? attachment.name : `${attachment.name} — ${size}`}
        className="block overflow-hidden rounded border border-border hover:border-foreground/40"
      >
        <img
          src={attachment.url}
          alt={attachment.name}
          loading="lazy"
          className="h-24 w-full bg-muted object-cover"
        />
      </a>
    );
  }
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded border border-border px-2 py-1.5 text-sm hover:border-foreground/40"
    >
      <Icon name="FileAttachment" className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
      {size === "" ? null : (
        <span className="shrink-0 text-xs text-muted-foreground">{size}</span>
      )}
    </a>
  );
}

function Comment({
  comment,
  members,
}: {
  comment: BoardComment;
  members: Map<string, BoardMember>;
}) {
  const author =
    comment.actorId === null ? null : (members.get(comment.actorId) ?? null);
  return (
    <li className="flex gap-2.5 py-2.5">
      <Avatar name={author?.name ?? "?"} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="text-foreground">{author?.name ?? "Someone"}</span>
          {comment.createdAt === null ? null : (
            <span>{formatDateTime(comment.createdAt)}</span>
          )}
          {comment.isInternal ? (
            <span className="rounded border border-border px-1">internal</span>
          ) : null}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
          {comment.text === "" ? "(empty)" : comment.text}
        </p>
      </div>
    </li>
  );
}

export function WorkItemPreview({
  accountId,
  projectId,
  identifier,
  item,
  states,
  labels,
  members,
  onClose,
}: {
  accountId: string;
  projectId: string;
  identifier: string;
  /** The card's own copy, shown immediately while the full record loads. */
  item: BoardWorkItem;
  states: Map<string, BoardState>;
  labels: Map<string, BoardLabel>;
  members: Map<string, BoardMember>;
  onClose: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    rpc.call("item_detail", { accountId, projectId, itemId: item.id }).then(
      (result) => {
        if (!cancelled) setDetail(result);
      },
      (cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, accountId, projectId, item.id]);

  // The card's copy stands in until the full record lands, so the preview
  // opens with content instead of a spinner.
  const shown = detail?.item ?? item;
  const state = shown.stateId === null ? null : (states.get(shown.stateId) ?? null);
  const itemLabels = shown.labelIds
    .map((id) => labels.get(id))
    .filter((label): label is BoardLabel => label !== undefined);
  const assignees = shown.assigneeIds
    .map((id) => members.get(id))
    .filter((member): member is BoardMember => member !== undefined);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] w-full max-w-2xl overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">
              {identifier}-{shown.sequenceId}
            </span>
            <UrlLink
              href={shown.url}
              target="_blank"
              className="flex items-center gap-1 hover:text-foreground hover:underline"
            >
              Open in Plane
              <Icon name="ExternalLink" className="size-3" />
            </UrlLink>
          </div>
          <DialogTitle className="text-left text-base leading-snug">
            {shown.name}
          </DialogTitle>
        </DialogHeader>

        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="divide-y divide-border">
          <div className="pb-1">
            <Property name="State">
              {state === null ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-2 rounded-full bg-muted-foreground"
                    style={dotStyle(state.color)}
                  />
                  {state.name}
                </span>
              )}
            </Property>
            <Property name="Priority">
              <span
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                  priorityClass(shown.priority),
                )}
              >
                {shown.priority}
              </span>
            </Property>
            <Property name="Assignees">
              {assignees.length === 0 ? (
                <span className="text-muted-foreground">Unassigned</span>
              ) : (
                assignees.map((member) => (
                  <span key={member.id} className="flex items-center gap-1.5">
                    <Avatar name={member.name} />
                    <span className="text-sm">{member.name}</span>
                  </span>
                ))
              )}
            </Property>
            <Property name="Labels">
              {itemLabels.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                itemLabels.map((label) => <LabelPill key={label.id} label={label} />)
              )}
            </Property>
            {shown.startDate === null && shown.targetDate === null ? null : (
              <Property name="Dates">
                <span className="text-sm text-muted-foreground">
                  {shown.startDate === null ? "—" : formatDate(shown.startDate)} →{" "}
                  {shown.targetDate === null ? "—" : formatDate(shown.targetDate)}
                </span>
              </Property>
            )}
            {shown.updatedAt === null ? null : (
              <Property name="Updated">
                <span className="text-sm text-muted-foreground">
                  {formatDateTime(shown.updatedAt)}
                </span>
              </Property>
            )}
          </div>

          <div className="py-3">
            <h3 className="text-xs font-medium text-muted-foreground">Description</h3>
            {detail === null ? (
              <p className="mt-1.5 text-sm text-muted-foreground">Loading…</p>
            ) : detail.description === "" ? (
              <p className="mt-1.5 text-sm text-muted-foreground">No description.</p>
            ) : (
              <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-foreground">
                {detail.description}
              </p>
            )}
          </div>

          <div className="py-3">
            <h3 className="text-xs font-medium text-muted-foreground">
              Attachments
              {detail === null || !detail.attachmentsAvailable
                ? ""
                : ` (${detail.attachments.length})`}
            </h3>
            {detail === null ? (
              <p className="mt-1.5 text-sm text-muted-foreground">Loading…</p>
            ) : !detail.attachmentsAvailable ? (
              <p className="mt-1.5 text-sm text-muted-foreground">
                This API key cannot read attachments.
              </p>
            ) : detail.attachments.length === 0 ? (
              <p className="mt-1.5 text-sm text-muted-foreground">No attachments.</p>
            ) : (
              <div className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
                {detail.attachments.map((attachment) => (
                  <Attachment key={attachment.id} attachment={attachment} />
                ))}
              </div>
            )}
          </div>

          <DelegateWorkItem
            accountId={accountId}
            projectId={projectId}
            itemId={item.id}
          />

          <div className="pt-3">
            <h3 className="text-xs font-medium text-muted-foreground">
              Comments
              {detail === null || !detail.commentsAvailable
                ? ""
                : ` (${detail.comments.length})`}
            </h3>
            {detail === null ? (
              <p className="mt-1.5 text-sm text-muted-foreground">Loading…</p>
            ) : !detail.commentsAvailable ? (
              <p className="mt-1.5 text-sm text-muted-foreground">
                This API key cannot read comments.
              </p>
            ) : detail.comments.length === 0 ? (
              <p className="mt-1.5 text-sm text-muted-foreground">No comments yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {detail.comments.map((comment) => (
                  <Comment key={comment.id} comment={comment} members={members} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
