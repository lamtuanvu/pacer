import { z } from "zod";
export const captureMetadataSchema = z.object({
  method: z.enum(["window", "content"]), scale: z.number().finite().positive().max(8),
  window_id: z.string().regex(/^[0-9]{1,20}$/), pid: z.number().int().min(2),
  app_version: z.string().min(1).max(128), app_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  captured_at_ms: z.number().int().nonnegative(),
  viewport_width: z.number().finite().positive().max(16384), viewport_height: z.number().finite().positive().max(16384),
  width: z.number().int().positive().max(16384).optional(), height: z.number().int().positive().max(16384).optional(),
});
export type CaptureMetadata = z.infer<typeof captureMetadataSchema>;
