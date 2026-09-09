// @vitest-environment jsdom
// The board page's data layer: caching with TanStack Query, realtime
// invalidation, and optimistic move rollback. The RPC layer is faked, so these
// assert the page's own behavior — what it fetches, when it refetches, and what
// it shows when a write fails.
import { beforeEach, describe, expect, it } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { BoardPage, queryClient } from "@/app";
import type { BoardAccount, BoardProject, BoardState, BoardWorkItem } from "@/server";

const account: BoardAccount = {
  id: "acc",
  label: "Work",
  serverUrl: "https://api.plane.so",
  workspace: "acme",
  webUrl: "",
  defaultProject: "",
  hasKey: true,
  ready: true,
};

const projectA: BoardProject = { id: "projA", name: "Alpha", identifier: "AL" };
const projectB: BoardProject = { id: "projB", name: "Beta", identifier: "BE" };

const states: BoardState[] = [
  { id: "s1", name: "Backlog", color: "#888888", group: "backlog", sequence: 1 },
  { id: "s2", name: "In Progress", color: "#ff8800", group: "started", sequence: 2 },
];

function item(id: string, name: string, stateId: string): BoardWorkItem {
  return {
    id,
    name,
    sequenceId: Number(id.replace(/\D/g, "")) || 1,
    priority: "medium",
    stateId,
    assigneeIds: [],
    labelIds: [],
    startDate: null,
    targetDate: null,
    createdAt: null,
    updatedAt: null,
    url: `https://app.plane.so/acme/projects/projA/issues/${id}`,
  };
}

const boardA = {
  project: projectA,
  states,
  labels: [],
  members: [],
  items: [item("w1", "First card", "s1"), item("w3", "Another item", "s1")],
  truncated: false,
};
const boardB = {
  project: projectB,
  states,
  labels: [],
  members: [],
  items: [item("w2", "Second card", "s2")],
  truncated: false,
};

function mountRoutes(subPath: string, overrides: Record<string, unknown> = {}) {
  const slot = renderSlot(
    { component: BoardPage },
    { subPath },
    {
      rpc: {
        accounts_list: () => ({ accounts: [account], remainingSlots: 4 }),
        projects_list: () => ({ projects: [projectA, projectB] }),
        board_load: ({ projectId }: { projectId: string }) =>
          projectId === "projA" ? boardA : boardB,
        item_move: () => item("w1", "First card", "s2"),
        item_create: () => item("w3", "New card", "s1"),
        ...overrides,
      } as never,
    },
  );
  return slot;
}

function boardLoadCount(slot: ReturnType<typeof renderSlot>, projectId: string): number {
  return slot.rpcCalls.filter(
    (call) =>
      call.method === "board_load" &&
      (call.input as { projectId?: string } | null)?.projectId === projectId,
  ).length;
}

beforeEach(() => {
  queryClient.clear();
});

describe("the board page's data layer", () => {
  it("loads a board once and reuses the cache when returning to it", async () => {
    const slot = mountRoutes("acc/projA");
    await screen.findByText("First card");
    expect(boardLoadCount(slot, "projA")).toBe(1);

    slot.rerender(<BoardPage subPath="acc/projB" />);
    await screen.findByText("Second card");
    expect(boardLoadCount(slot, "projB")).toBe(1);

    // Back to A within the stale window: no network call, cached cards reappear.
    slot.rerender(<BoardPage subPath="acc/projA" />);
    await screen.findByText("First card");
    expect(boardLoadCount(slot, "projA")).toBe(1);
    expect(screen.queryByText("Second card")).toBeNull();
  });

  it("refetches the visible board when a board-changed signal arrives", async () => {
    const slot = mountRoutes("acc/projA");
    await screen.findByText("First card");
    expect(boardLoadCount(slot, "projA")).toBe(1);

    await slot.emitRealtime("board-changed", { projectId: "projA" });
    await waitFor(() => expect(boardLoadCount(slot, "projA")).toBeGreaterThanOrEqual(2));
  });

  it("restores the previous state when an optimistic move fails", async () => {
    const slot = mountRoutes("acc/projA", {
      item_move: () => {
        throw new Error("Plane unreachable");
      },
    });
    await screen.findByText("First card");

    const backlogHeading = screen.getByText("Backlog");
    const inProgressHeading = screen.getByText("In Progress");

    const dataTransfer = fakeDataTransfer();
    dataTransfer.setData("text/plane-work-item", "w1");
    // The drop is dispatched on the heading and bubbles to the column's own
    // drop handler, the way a real drag lands on the column.
    fireEvent.drop(inProgressHeading, { dataTransfer });

    await waitFor(() => {
      const backlogColumn = backlogHeading.parentElement!.parentElement!;
      const inProgressColumn = inProgressHeading.parentElement!.parentElement!;
      expect(backlogColumn.textContent).toContain("First card");
      expect(inProgressColumn.textContent).not.toContain("First card");
    });
    // The failed write still settles, which refetches the board; if the drop
    // had not reached the move handler this count would stay at 1.
    await waitFor(() => expect(boardLoadCount(slot, "projA")).toBeGreaterThanOrEqual(2));
  });

  it("filters the visible cards as the search query is typed", async () => {
    mountRoutes("acc/projA");
    await screen.findByText("First card");
    expect(screen.getByText("Another item")).toBeTruthy();

    const input = screen.getByLabelText("Search work items");
    fireEvent.change(input, { target: { value: "first" } });
    expect(screen.getByText("First card")).toBeTruthy();
    expect(screen.queryByText("Another item")).toBeNull();

    // The boards item key matches the search too (AL-1).
    fireEvent.change(input, { target: { value: "AL-1" } });
    expect(screen.getByText("First card")).toBeTruthy();

    fireEvent.change(input, { target: { value: "zzz-no-match" } });
    expect(await screen.findByText(/No work items match/i)).toBeTruthy();
  });
});

function fakeDataTransfer() {
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => {
      data.set(type, value);
    },
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "move",
    dropEffect: "move",
  };
}
