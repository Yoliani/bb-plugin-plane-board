// The kanban board: one column per Plane state, cards dragged between them.
//
// Drag and drop uses the native HTML5 drag events rather than a drag library —
// a card carries its id in the drag payload and a column accepts a drop by
// asking the page to move that item into its state. Clicking a card opens the
// preview instead.
import { useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import type { BoardLabel, BoardMember, BoardState, BoardWorkItem } from "@/server";
import { Avatar, LabelPill } from "@/components/work-item-preview";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { dotStyle, formatDate, priorityClass, priorityRank } from "@/lib/plane-ui";
import { cn } from "@/lib/utils";

/** Plane's state groups, in the order a board reads left to right. */
const GROUP_ORDER = ["backlog", "unstarted", "started", "completed", "cancelled"];

/** Columns follow Plane's own ordering: state group first, then sequence. */
export function sortStates(states: BoardState[]): BoardState[] {
  return [...states].sort((left, right) => {
    const byGroup = groupRank(left.group) - groupRank(right.group);
    return byGroup === 0 ? left.sequence - right.sequence : byGroup;
  });
}

function groupRank(group: string): number {
  const index = GROUP_ORDER.indexOf(group);
  return index === -1 ? GROUP_ORDER.length : index;
}

function WorkItemCard({
  item,
  identifier,
  labels,
  members,
  isMoving,
  onOpen,
  onDragStart,
}: {
  item: BoardWorkItem;
  identifier: string;
  labels: Map<string, BoardLabel>;
  members: Map<string, BoardMember>;
  isMoving: boolean;
  onOpen: () => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
}) {
  const itemLabels = item.labelIds
    .map((id) => labels.get(id))
    .filter((label): label is BoardLabel => label !== undefined);
  const assignees = item.assigneeIds
    .map((id) => members.get(id))
    .filter((member): member is BoardMember => member !== undefined);
  const hasMeta = item.targetDate !== null || assignees.length > 0;

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={!isMoving}
      onDragStart={onDragStart}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "cursor-grab rounded-lg border border-border bg-card p-3 text-left shadow-sm transition-opacity",
        "hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "active:cursor-grabbing",
        isMoving && "pointer-events-none opacity-50",
      )}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">
          {identifier}-{item.sequenceId}
        </span>
        {item.priority === "none" ? null : (
          <span
            className={cn(
              "rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
              priorityClass(item.priority),
            )}
          >
            {item.priority}
          </span>
        )}
      </div>
      <p className="mt-1.5 line-clamp-3 text-sm leading-snug text-foreground">{item.name}</p>
      {itemLabels.length === 0 ? null : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {itemLabels.map((label) => (
            <LabelPill key={label.id} label={label} />
          ))}
        </div>
      )}
      {hasMeta ? (
        <div className="mt-2 flex items-center gap-2.5 text-xs text-muted-foreground">
          {item.targetDate === null ? null : (
            <span className="whitespace-nowrap">{formatDate(item.targetDate)}</span>
          )}
          {assignees.length === 0 ? null : (
            <span className="ml-auto flex -space-x-1">
              {assignees.map((member) => (
                <Avatar key={member.id} name={member.name} />
              ))}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

function AddCard({
  onCreate,
  onCancel,
}: {
  onCreate: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const submit = () => {
    const trimmed = name.trim();
    if (trimmed === "") {
      onCancel();
      return;
    }
    onCreate(trimmed);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
    if (event.key === "Escape") onCancel();
  };
  return (
    <Input
      autoFocus
      value={name}
      placeholder="Work item title"
      aria-label="New work item title"
      onChange={(event) => setName(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={submit}
    />
  );
}

function Column({
  state,
  items,
  identifier,
  labels,
  members,
  movingItemId,
  isAdding,
  filtering,
  onStartAdd,
  onCancelAdd,
  onCreate,
  onOpenItem,
  onDropItem,
}: {
  state: BoardState;
  items: BoardWorkItem[];
  identifier: string;
  labels: Map<string, BoardLabel>;
  members: Map<string, BoardMember>;
  movingItemId: string | null;
  isAdding: boolean;
  filtering: boolean;
  onStartAdd: () => void;
  onCancelAdd: () => void;
  onCreate: (name: string) => void;
  onOpenItem: (item: BoardWorkItem) => void;
  onDropItem: (itemId: string) => void;
}) {
  const [isOver, setIsOver] = useState(false);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsOver(false);
    const itemId = event.dataTransfer.getData("text/plane-work-item");
    if (itemId !== "") onDropItem(itemId);
  };

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setIsOver(true);
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={onDrop}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-lg border border-transparent bg-muted/30 transition-colors",
        isOver && "border-primary/50 bg-muted/60",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full bg-muted-foreground"
          style={dotStyle(state.color)}
        />
        <span className="truncate text-sm font-medium text-foreground">{state.name}</span>
        <span className="text-xs text-muted-foreground">{items.length}</span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-6 text-muted-foreground hover:text-foreground"
          aria-label={`Add a work item to ${state.name}`}
          onClick={onStartAdd}
        >
          <Icon name="Plus" className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-24 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {isAdding ? <AddCard onCreate={onCreate} onCancel={onCancelAdd} /> : null}
        {items.map((item) => (
          <WorkItemCard
            key={item.id}
            item={item}
            identifier={identifier}
            labels={labels}
            members={members}
            isMoving={movingItemId === item.id}
            onOpen={() => onOpenItem(item)}
            onDragStart={(event) => {
              event.dataTransfer.setData("text/plane-work-item", item.id);
              event.dataTransfer.effectAllowed = "move";
            }}
          />
        ))}
        {items.length === 0 && !isAdding && !filtering ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            Drop a work item here
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function Board({
  states,
  items,
  identifier,
  labels,
  members,
  movingItemId,
  onMove,
  onCreate,
  onOpenItem,
  filtering = false,
}: {
  states: BoardState[];
  items: BoardWorkItem[];
  identifier: string;
  labels: Map<string, BoardLabel>;
  members: Map<string, BoardMember>;
  movingItemId: string | null;
  onMove: (itemId: string, stateId: string) => void;
  onCreate: (stateId: string, name: string) => void;
  onOpenItem: (item: BoardWorkItem) => void;
  /** True while the user is filtering cards with the search box. */
  filtering?: boolean;
}) {
  const [addingStateId, setAddingStateId] = useState<string | null>(null);

  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto px-4 pb-4 md:px-5">
      {sortStates(states).map((state) => {
        const columnItems = items
          .filter((item) => item.stateId === state.id)
          .sort(
            (left, right) => priorityRank(left.priority) - priorityRank(right.priority),
          );
        return (
          <Column
            key={state.id}
            state={state}
            items={columnItems}
            identifier={identifier}
            labels={labels}
            members={members}
            movingItemId={movingItemId}
            isAdding={addingStateId === state.id}
            filtering={filtering}
            onStartAdd={() => setAddingStateId(state.id)}
            onCancelAdd={() => setAddingStateId(null)}
            onCreate={(name) => {
              setAddingStateId(null);
              onCreate(state.id, name);
            }}
            onOpenItem={onOpenItem}
            onDropItem={(itemId) => onMove(itemId, state.id)}
          />
        );
      })}
    </div>
  );
}
