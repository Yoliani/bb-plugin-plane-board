See your Plane board next to the work it tracks, without leaving BB.

## What you get

- A **Plane** page in the left sidebar: one column per project state, cards
  showing the work item's identifier, title, priority, labels, assignees, and
  target date.
- Click a card for a preview: state, priority, assignees, labels, dates, the
  description, its attached files, and the comment thread, without leaving the
  board. Attached images show themselves; anything else downloads.
- Drag a card to another column to move the work item to that state in Plane.
- Add a work item straight into a column, or open one in Plane in a click.
- A project picker, with the selected project in the URL so a board is a link
  you can share or bookmark.
- Live updates, so a move made in another window reaches every open board.

## Work items where the agents are

- **`@` a work item in any composer.** The mention menu searches your Plane
  workspaces; picking one drops the whole ticket — properties, description,
  comments, attachment list — into the message as context the agent can read.
- **Delegate a ticket to an agent.** "Delegate to an agent" on a work item
  starts a BB thread seeded with the ticket and remembers the link, so the card
  shows every thread that has worked it and how each one is doing.
- **`::plane{key="GA-724"}`** in an agent's reply renders as a live card —
  current state, title and priority — that opens the item on the board.
- **A `bb plane-board` CLI and a skill**, so an agent can read a ticket, file
  one, move it, comment, and pull down an attachment using the same connection
  the board uses. There is no second API key to configure.

## Plane Cloud, your own instance, or several at once

Click **Add account** in the plugin's Accounts panel, fill in a workspace and
an API key, and it tests the connection for you. Keep up to five side by side —
a Cloud account and a self-hosted instance, say — and switch between them from
the picker in the board's header.

Authentication is a personal access token from Plane's profile settings. Each
account's key is stored as a secret on the BB server: the browser never sees a
key and never talks to Plane directly.

## Checking the connection

`bb plane-board accounts` lists every connection and marks the ones that are
usable. `bb plane-board check` reports a connection's server, workspace, and
how many projects its key can see — the fastest way to tell a wrong key from a
wrong workspace slug.
