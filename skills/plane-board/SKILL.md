---
name: plane-board
description: Read and write Plane work items with the `bb plane-board` CLI — search, read a ticket with its comments and attachments, file one, move it between states, comment, download an attachment, and delegate a ticket to a BB agent thread. Use when picking up a Plane ticket, when the prompt mentions a work-item key such as GA-724, when filing an issue found while coding, or when reporting back after shipping.
---

# Plane board

`bb plane-board` reads and writes the same Plane connections the board panel
uses, so there is no second API key to configure. Run `bb plane-board check`
first if a command fails with an auth error.

A **KEY** is a work-item key like `GA-724`. Every command takes `--json` for
machine-readable output and `--account <id>` to pick a connection when more
than one is configured.

## Work a ticket

1. Read it before acting. `show` returns the description, comments, and
   attachment list in one call:

   ```sh
   bb plane-board show GA-724
   ```

2. Fetch any attachment that matters rather than guessing at it:

   ```sh
   bb plane-board attachment list GA-724
   bb plane-board attachment get GA-724 screenshot.png --out ./screenshot.png
   ```

3. Move it as you go, and comment at each meaningful milestone:

   ```sh
   bb plane-board update GA-724 --state "In Progress"
   bb plane-board comment GA-724 "Reproduced on staging; the 401 handler clears the token before the router sees it."
   ```

4. When the work is ready for review:

   ```sh
   bb plane-board update GA-724 --state "In Review"
   ```

   If it cannot proceed, leave the state accurate and comment with the specific
   blocker, what you tried, and what would unblock it. Do not move a blocked
   ticket to a done state.

## Find work

```sh
bb plane-board search "share link"          # across the whole workspace
bb plane-board list --state started         # one project, by state group
bb plane-board list --project GA --limit 20
```

`--state` takes a state name (`In Progress`) or a group: `backlog`,
`unstarted`, `started`, `completed`, `cancelled`.

## File a ticket

```sh
bb plane-board create "Session expiry drops the user to login with no message" \
  --project GA --priority high \
  --description "Any 401 clears the stored token, so the app routes back to login mid-task."
```

Priorities are `urgent`, `high`, `medium`, `low`, `none`.

## Delegate a ticket to an agent

```sh
bb plane-board delegate GA-724 --bb-project proj_abc123 \
  --instructions "Reproduce first, then fix. Do not change the share-link schema."
```

This starts a BB thread seeded with the whole ticket and links it to the work
item. Run `bb plane-board delegate GA-724` with no `--bb-project` to see the
project ids. `bb plane-board threads GA-724` lists what is already running on
it — check that before starting another.

## Link a work item in a response

When your answer refers the reader to a work item, emit this leaf directive on
its own line instead of writing the key as plain text:

```md
::plane{key="GA-724"}
```

`key` is required. Add `title="…"` as a fallback shown while the card loads and
when the key no longer resolves. The card shows the live state, title and
priority, and opens the item on the board. One directive per line.

## Invariants

- Prefer keys (`GA-724`) over UUIDs; every command accepts them.
- A key is resolved by searching every configured connection in order, so an
  ambiguous key across two Plane instances resolves to the first match. Pass
  `--account <id>` when that matters.
- Write one comment per meaningful milestone. Say what changed or was learned,
  what validation ran, and any remaining risk. Never post command-by-command
  narration.
- `--out` for `attachment get` is resolved against the directory the command
  ran in, and the file is written on BB's primary host.
