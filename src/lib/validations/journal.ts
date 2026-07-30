import { z } from 'zod';

export const createJournalEntrySchema = z.object({
  note: z.string().trim().min(1, 'Note cannot be empty').max(1000, 'Note is too long'),
});

export type CreateJournalEntryInput = z.infer<typeof createJournalEntrySchema>;
