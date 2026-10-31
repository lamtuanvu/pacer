/** Schedule against an absolute clock without overflowing the runtime's 32-bit timer. */
export function scheduleDeadline(
  deadlineAt: number,
  expire: () => void,
  unref = false,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const arm = () => {
    if (cancelled || deadlineAt === Infinity) return;
    const remaining = deadlineAt - Date.now();
    timer = setTimeout(
      () => {
        if (cancelled) return;
        if (Date.now() >= deadlineAt) expire();
        else arm();
      },
      Math.max(0, Math.min(2147483647, Math.ceil(remaining))),
    );
    if (unref) timer.unref?.();
  };
  arm();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
