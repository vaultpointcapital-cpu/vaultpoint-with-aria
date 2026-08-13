import { z } from 'zod';

export const tier1VerifySchema = z.object({
  phone: z.string().trim().min(7, 'A valid phone number is required'),
  email: z.string().trim().email('A valid email address is required'),
  idType: z.enum(['national_id', 'drivers_license', 'passport', 'voters_card']),
  idNumber: z.string().trim().min(4, 'A valid ID number is required'),
});

export type Tier1VerifyInput = z.infer<typeof tier1VerifySchema>;

export const tier2VerifySchema = z.object({
  bvnOrNin: z.string().trim().regex(/^\d{10,11}$/, 'BVN/NIN must be 10-11 digits'),
  // Opaque reference only (e.g. an upload id) — real selfie capture/storage
  // is out of scope, see src/lib/kyc/wallet-tier2-vendor.ts.
  livenessSelfieRef: z.string().trim().min(1, 'A liveness capture is required'),
});

export type Tier2VerifyInput = z.infer<typeof tier2VerifySchema>;
