/** Descriptions only: parsing a record never grants bootstrap authority. */
import { z } from "zod";
const path = z.string().min(1).max(4096).refine(value => value.startsWith("/") && !/[\x00-\x1f\x7f]/.test(value) && !value.split("/").some(part => part === "." || part === ".."));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const legacySourceEvidenceSchema = z.object({
  schema: z.literal(1),
  uid: z.number().int().nonnegative().max(0xffffffff),
  process: z.object({ pid: z.number().int().positive().max(0x7fffffff), bootId: z.string().min(1).max(128), birth: z.string().min(1).max(128) }).strict(),
  executable: path,
  file: z.object({ device: decimal, inode: decimal, size: z.number().int().nonnegative().max(512 * 1024 * 1024), modifiedNs: decimal, changedNs: decimal, sha256: digest, cdhash: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  registration: z.object({ label: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), home: path, pacerHome: path, port: z.number().int().min(1).max(65535), sha256: digest }).strict(),
}).strict();
export type LegacySourceEvidence = z.infer<typeof legacySourceEvidenceSchema>;
export type LegacyReleaseInspection = { supported: false; reason: "unknown-release" | "destination-older" | "legacy-update-bypasses-reservation"; version: string | null };
