// Fetch a session's *.hydra bundle (meta + history JSON) from the
// daemon's REST endpoint. The session-end uploader attaches this to
// the Slack thread so recipients can re-import the session into any
// hydra and continue the conversation.
//
// The bundle is canonical — same shape the CLI's
// `hydra-acp sessions export` produces and `hydra-acp sessions import`
// consumes.

export async function fetchHydraBundleText(opts: {
  daemonUrl: string;
  token: string;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<string> {
  const url = `${opts.daemonUrl}/v1/sessions/${encodeURIComponent(opts.sessionId)}/export`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${opts.token}` },
    signal: opts.signal,
  });
  if (!r.ok) {
    throw new Error(`hydra GET ${url} returned ${r.status} ${r.statusText}`);
  }
  return r.text();
}
