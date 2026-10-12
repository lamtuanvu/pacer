/** Mutable stdin boundary so CLI hooks can be exercised without process input. */
export const io = { readStdin: (): Promise<string> => Bun.stdin.text() };
