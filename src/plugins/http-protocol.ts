import { z } from "zod";
import type { MethodDef } from "./protocol";

export const HTTP_BODY_CHUNK_FEATURE = "httpBodyChunks";
export const HTTP_BODY_MAX_BYTES = 4 * 1024 * 1024;
export const HTTP_BODY_CHUNK_BYTES = 256 * 1024;
const bytes = z.number().int().nonnegative().safe();
const bodyBytes = bytes.max(HTTP_BODY_MAX_BYTES);
const handle = z.string().min(1).max(256);
export const secretReference = z
  .string()
  .regex(/^(?:(?:env|secrets|endpoint):[A-Za-z0-9_][A-Za-z0-9_.-]*|endpoint\/[a-z0-9][a-z0-9-]*)$/);
export const httpBodyText = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= HTTP_BODY_MAX_BYTES,
    "HTTP body exceeds 4 MiB UTF8",
  );
export const httpBodyReference = z.object({ handle }).strict();
const responseBodyReference = httpBodyReference
  .extend({ bytes: bodyBytes })
  .strict();
const base64 = z
  .string()
  .max(349528)
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/,
  )
  .refine(
    (value) => Buffer.from(value, "base64").length <= HTTP_BODY_CHUNK_BYTES,
    "HTTP chunk exceeds 256 KiB decoded",
  );
/** Full encoded metadata envelopes must also fit the unchanged transport line cap. */
export const httpRequest = z
  .object({
    url: z
      .url()
      .refine(
        (value) => ["http:", "https:"].includes(new URL(value).protocol),
        "HTTP(S) URL required",
      ),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.union([httpBodyText, httpBodyReference]).optional(),
    timeoutMs: z.number().int().positive().max(120000),
    authorization: z
      .object({
        secretRef: secretReference,
        scheme: z.string().default("Bearer"),
      })
      .strict()
      .optional(),
  })
  .strict();
export const httpResponse = z.object({
  status: z.number(),
  headers: z.record(z.string(), z.string()),
  body: z.union([httpBodyText, responseBodyReference]),
});
export type HttpWireRequest = z.input<typeof httpRequest>;
export type HttpWireResponse = z.infer<typeof httpResponse>;
export const HTTP_CAPABILITY_METHODS: Record<string, MethodDef> = {
  "capability.net.http": {
    description:
      "HTTP without redirects to captured declared/granted hosts. Bodies are at most 4 MiB; chunk references require httpBodyChunks. Injected secrets never return; reflection refuses the response.",
    params: httpRequest,
    result: httpResponse,
    deadlineMs: 125000,
  },
  "capability.secrets.check": {
    description:
      "Report only whether a valid secret reference resolves, never its value; endpoint references remain absent until endpoint support. Authorized by the secrets.resolve capability.",
    params: z.object({ ref: secretReference }).strict(),
    result: z.object({ present: z.boolean() }),
    deadlineMs: 2000,
  },
  "capability.net.http.body.begin": {
    description:
      "Begin a bounded upload owned by the current call; requires negotiated httpBodyChunks.",
    params: z.object({ bytes: bodyBytes }).strict(),
    result: httpBodyReference,
    deadlineMs: 5000,
  },
  "capability.net.http.body.stageChunk": {
    description:
      "Stage a contiguous canonical base64 upload chunk, at most 256 KiB decoded; handle direction and owner are checked by host.",
    params: httpBodyReference.extend({ offset: bodyBytes, base64 }).strict(),
    result: z.object({ bytes: bodyBytes }),
    deadlineMs: 5000,
  },
  "capability.net.http.body.readChunk": {
    description:
      "Read a response-only bounded chunk from this live call's handle.",
    params: httpBodyReference
      .extend({ offset: bodyBytes, length: bytes.max(HTTP_BODY_CHUNK_BYTES) })
      .strict(),
    result: z.object({ base64 }),
    deadlineMs: 5000,
  },
  "capability.net.http.body.release": {
    description:
      "Release an owned HTTP body handle; no authority or consumed upload is revived.",
    params: httpBodyReference,
    result: z.object({ ok: z.literal(true) }),
    deadlineMs: 5000,
  },
};
export const HTTP_METHOD_CAPABILITY: Readonly<
  Record<string, "net.http" | "secrets.resolve">
> = Object.fromEntries(
  Object.keys(HTTP_CAPABILITY_METHODS).map((name) => [
    name,
    name === "capability.secrets.check" ? "secrets.resolve" : "net.http",
  ]),
) as Readonly<Record<string, "net.http" | "secrets.resolve">>;
