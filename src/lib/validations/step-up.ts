import { z } from 'zod';

export const initiateStepUpSchema = z.object({
  action_type: z.string().trim().min(1).max(100),
  resource_id: z.string().trim().min(1).max(200).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type InitiateStepUpInput = z.infer<typeof initiateStepUpSchema>;

/**
 * signed_response is a hex-encoded HMAC-SHA256 (64 hex chars) — see
 * verifyPushResponse in src/lib/auth/step-up.ts for what it's computed
 * over. totp_code is the standard 6-digit TOTP format, accepted at the
 * schema level even though no enrollment exists yet (Ticket 3) — a
 * request using it is rejected as "method not offered", never faked.
 */
export const confirmStepUpSchema = z
  .object({
    approval_id: z.string().trim().min(1),
    method: z.enum(['push', 'totp']),
    signed_response: z.string().trim().regex(/^[0-9a-f]{64}$/i).optional(),
    totp_code: z.string().trim().regex(/^\d{6}$/).optional(),
  })
  .refine((data) => (data.method === 'push' ? !!data.signed_response : true), {
    message: 'signed_response is required for method "push"',
    path: ['signed_response'],
  })
  .refine((data) => (data.method === 'totp' ? !!data.totp_code : true), {
    message: 'totp_code is required for method "totp"',
    path: ['totp_code'],
  });

export type ConfirmStepUpInput = z.infer<typeof confirmStepUpSchema>;
