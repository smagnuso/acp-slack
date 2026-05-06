// Streaming ndjson splitter. Accumulates chunks, yields complete lines as
// parsed JSON objects via a callback.

export class NdjsonParser {
  private buf = "";

  constructor(
    private readonly onMessage: (msg: unknown) => void,
    private readonly onError: (err: Error, raw: string) => void,
  ) {}

  push(chunk: Buffer | string): void {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl = this.buf.indexOf("\n");
    while (nl !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line.length > 0) {
        try {
          this.onMessage(JSON.parse(line));
        } catch (err) {
          this.onError(err as Error, line);
        }
      }
      nl = this.buf.indexOf("\n");
    }
  }

  // Flush any trailing buffered data on close. Most well-behaved peers send a
  // final newline, but in case they don't.
  flush(): void {
    const tail = this.buf.trim();
    this.buf = "";
    if (tail.length === 0) {
      return;
    }
    try {
      this.onMessage(JSON.parse(tail));
    } catch (err) {
      this.onError(err as Error, tail);
    }
  }
}
