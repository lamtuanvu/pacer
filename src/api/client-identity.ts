/** The validated `X-Pacer-Client` and `X-Pacer-Client-Instance` request headers. */
export function clientIdentity(label: string, instance: string): { client?: string; clientInstance?: { label: string; id: string } } {
  const client = /^[a-z][a-z0-9:-]{0,31}\/[0-9A-Za-z.+-]{1,32}$/.test(label) ? label : undefined;
  // A window or process id the client picks once, so two instances of one client contend for a lane's driving lease.
  const clientInstance = /^[A-Za-z0-9._:-]{1,64}$/.test(instance) ? { label: client ?? (label === "app" ? "app" : "http"), id: instance } : undefined;
  return { client, clientInstance };
}
