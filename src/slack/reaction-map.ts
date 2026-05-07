// Reaction → action mapping. Mirrors agent-shell-to-go--reaction-map.

export type ReactionAction =
  | "allow"
  | "allow_always"
  | "deny"
  | "cancel"
  | "hide"
  | "expand_truncated"
  | "expand_full"
  | "heart"
  | "bookmark";

const MAP: Record<string, ReactionAction> = {
  white_check_mark: "allow",
  "+1": "allow",
  star: "allow",
  unlock: "allow_always",
  x: "deny",
  "-1": "deny",
  // Targeted at the spinner ts to send session/cancel; ignored on
  // any other message.
  stop_sign: "cancel",
  octagonal_sign: "cancel",

  see_no_evil: "hide",
  no_bell: "hide",

  eyes: "expand_truncated",

  book: "expand_full",
  open_book: "expand_full",
  books: "expand_full",

  heart: "heart",
  heart_eyes: "heart",
  heartpulse: "heart",
  sparkling_heart: "heart",
  two_hearts: "heart",
  revolving_hearts: "heart",

  bookmark: "bookmark",
};

export function reactionAction(name: string): ReactionAction | undefined {
  return MAP[name];
}
