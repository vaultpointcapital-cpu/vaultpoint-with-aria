import { z } from 'zod';

export const registerDeviceSchema = z.object({
  device_token: z.string().trim().min(10).max(4096),
  platform: z.enum(['ios', 'android']),
});

export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;
