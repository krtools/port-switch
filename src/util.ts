export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The error's code (ENOENT, ECONNRESET, ...) if it has one. */
export const errCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;

export const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Short form for logs and the UI: the code if there is one, else the message. */
export const errText = (err: unknown): string => errCode(err) || errMsg(err);
