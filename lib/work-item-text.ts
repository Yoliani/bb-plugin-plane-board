// One work item as Markdown, for the places an agent reads it rather than
// looks at it: the context an @-mention resolves to, the seed prompt a
// delegated thread starts from, and `bb plane-board show`.
//
// These three used to be three different renderings of the same ticket, which
// is how a mention and a delegation end up disagreeing about what a work item
// says. They share this one.

export interface WorkItemContext {
  /** The human key, e.g. "GA-724". */
  key: string;
  title: string;
  url: string;
  projectName: string;
  stateName: string | null;
  priority: string;
  labels: string[];
  assignees: string[];
  startDate: string | null;
  targetDate: string | null;
  updatedAt: string | null;
  description: string;
  comments: { author: string; createdAt: string | null; text: string }[];
  attachments: { name: string; size: number | null }[];
}

function field(name: string, value: string): string | null {
  return value === "" ? null : `- ${name}: ${value}`;
}

/**
 * The ticket as Markdown. Everything Plane stores as HTML has already been
 * flattened to text by the API client, so nothing here is markup.
 */
export function renderWorkItem(context: WorkItemContext): string {
  const lines: string[] = [`# ${context.key} — ${context.title}`, ""];

  const properties = [
    field("Project", context.projectName),
    field("State", context.stateName ?? "none"),
    field("Priority", context.priority),
    field("Labels", context.labels.join(", ")),
    field("Assignees", context.assignees.join(", ")),
    field("Start date", context.startDate ?? ""),
    field("Target date", context.targetDate ?? ""),
    field("Updated", context.updatedAt ?? ""),
    field("URL", context.url),
  ].filter((line): line is string => line !== null);
  lines.push(...properties, "");

  lines.push("## Description", "");
  lines.push(context.description === "" ? "_No description._" : context.description, "");

  if (context.attachments.length > 0) {
    lines.push("## Attachments", "");
    for (const attachment of context.attachments) {
      const size = attachment.size === null ? "" : ` (${attachment.size} bytes)`;
      lines.push(`- ${attachment.name}${size}`);
    }
    lines.push(
      "",
      "_Fetch one with `bb plane-board attachment get <key> <name> --out <path>`._",
      "",
    );
  }

  if (context.comments.length > 0) {
    lines.push("## Comments", "");
    for (const comment of context.comments) {
      const when = comment.createdAt === null ? "" : ` — ${comment.createdAt}`;
      lines.push(`### ${comment.author}${when}`, "", comment.text, "");
    }
  }

  return lines.join("\n").trimEnd();
}

/**
 * What a delegated thread starts from: the ticket, then what to do with it.
 * The instructions come last so they are the most recent thing in context.
 */
export function renderSeedPrompt(
  context: WorkItemContext,
  instructions: string,
): string {
  const task =
    instructions.trim() === ""
      ? `Work on ${context.key}. Read the ticket below, then start.`
      : instructions.trim();
  return [
    renderWorkItem(context),
    "",
    "---",
    "",
    task,
    "",
    `Report back on the work item when you are done: \`bb plane-board comment ${context.key} "…"\`.`,
  ].join("\n");
}
