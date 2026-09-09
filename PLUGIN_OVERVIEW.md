See your Plane board next to the work it tracks, without leaving BB.

## What you get

- A **Plane** page in the left sidebar: one column per project state, cards
  showing the work item's identifier, title, priority, labels, assignees, and
  target date.
- Click a card for a preview: state, priority, assignees, labels, dates, the
  description, and the comment thread, without leaving the board.
- Drag a card to another column to move the work item to that state in Plane.
- Add a work item straight into a column, or open one in Plane in a click.
- A project picker, with the selected project in the URL so a board is a link
  you can share or bookmark.
- Live updates, so a move made in another window reaches every open board.

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
