import { z } from 'zod';
import type { MethodDef } from './protocol';

export const notificationMessage = z.object({
  key: z.string(),
  title: z.string().max(256),
  body: z.string().max(2048),
  url: z.string(),
});
export const notificationResult = z.object({ delivered: z.boolean() });
export const NOTIFIER_METHODS: Record<string, MethodDef> = {
  'notifier.deliver': {
    description: 'Deliver one notification. Return delivered: false when this notifier cannot show it so the host tries the next provider.',
    params: notificationMessage,
    result: notificationResult,
    deadlineMs: 5000,
  },
};
