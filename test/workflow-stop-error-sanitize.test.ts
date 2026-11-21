import { describe, expect, test } from "bun:test";
import { sanitizeStopError } from "../src/workflow/orchestrator";

describe("sanitizeStopError", () => {
  const cases: Array<{ name: string; input: string; expect: (out: string) => void }> = [
    {
      name: "scrubs POSIX path with spaces in full",
      input: "fail /Users/bob/My Proj/a.ts",
      expect: out => {
        expect(out).toBe("fail <path>");
        expect(out).not.toContain("Proj");
        expect(out).not.toContain("/Users");
      },
    },
    {
      name: "scrubs /private/tmp without leaving /private",
      input: "err /private/tmp/x",
      expect: out => {
        expect(out).toBe("err <path>");
        expect(out).not.toContain("/private");
      },
    },
    {
      name: "scrubs Windows drive path with backslashes",
      input: String.raw`conflict C:\Users\bob\run\a.ts`,
      expect: out => {
        expect(out).toBe("conflict <path>");
        expect(out).not.toMatch(/C:\\Users/i);
      },
    },
    {
      name: "scrubs Windows drive path with forward slashes",
      input: "conflict C:/Users/bob/run/a.ts",
      expect: out => {
        expect(out).toBe("conflict <path>");
        expect(out).not.toContain("C:/Users");
      },
    },
    {
      name: "scrubs /opt root paths",
      input: "bin /opt/app/bin",
      expect: out => expect(out).toBe("bin <path>"),
    },
    {
      name: "scrubs /etc root paths",
      input: "cfg /etc/passwd",
      expect: out => expect(out).toBe("cfg <path>"),
    },
    {
      name: "scrubs /root root paths",
      input: "key /root/.ssh/id",
      expect: out => expect(out).toBe("key <path>"),
    },
    {
      name: "scrubs /mnt root paths",
      input: "vol /mnt/data/x",
      expect: out => expect(out).toBe("vol <path>"),
    },
    {
      name: "scrubs /workspace root paths",
      input: "repo /workspace/repo/a.ts",
      expect: out => expect(out).toBe("repo <path>"),
    },
    {
      name: "keeps escaped spaces inside the scrubbed path",
      input: String.raw`at /tmp/foo\ bar/x.ts: next`,
      expect: out => {
        expect(out).toBe("at <path>: next");
        expect(out).not.toContain("/tmp");
      },
    },
    {
      name: "does not scrub relative paths",
      input: "rel/path/only",
      expect: out => expect(out).toBe("rel/path/only"),
    },
    {
      name: "caps sanitized text at 300 chars",
      input: `${"/tmp/a;".repeat(50)}${"z".repeat(50)}`,
      expect: out => {
        expect(out.length).toBe(300);
        expect(out).toContain("<path>");
        expect(out).not.toContain("/tmp/");
      },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      c.expect(sanitizeStopError(c.input));
    });
  }
});
