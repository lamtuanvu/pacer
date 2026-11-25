import type { PreparedPlannerBuilder } from "@pacer/plugin/install";
export type PlannerBuilder = PreparedPlannerBuilder & {
  context: {
    home: string;
    env: Record<string, string>;
    binary: string | null;
    list(dir: string, glob: string): Promise<string[]>;
  };
};
