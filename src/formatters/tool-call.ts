// Tool-call rendering matches agent-shell-to-go's status icons:
//   pending      ▶
//   in_progress  🔄
//   completed    ✅
//   failed       ❌
//   rejected     🚫
// We render a one-line "header" ("<icon> <kind> · <title>") and an optional
// body that flows through the truncate / full-expand pipeline.

export type ToolCallStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "rejected";

const STATUS_ICONS: Record<ToolCallStatus, string> = {
  pending: ":arrow_forward:",
  in_progress: ":arrows_counterclockwise:",
  completed: ":white_check_mark:",
  failed: ":x:",
  rejected: ":no_entry_sign:",
};

export function statusIcon(status: ToolCallStatus | string | undefined): string {
  if (status && (status as ToolCallStatus) in STATUS_ICONS) {
    return STATUS_ICONS[status as ToolCallStatus];
  }
  return STATUS_ICONS.pending;
}

export interface ToolCallHeader {
  status: ToolCallStatus | string | undefined;
  title?: string | undefined;
  kind?: string | undefined;
}

export function renderToolCallHeader(h: ToolCallHeader): string {
  const icon = statusIcon(h.status);
  const parts: string[] = [icon];
  if (h.kind) {
    parts.push(`\`${h.kind}\``);
  }
  if (h.title) {
    parts.push(h.title.split("\n", 1)[0] ?? h.title);
  }
  return parts.join(" ");
}
