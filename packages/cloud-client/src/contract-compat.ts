/**
 * Compile-time guard: the Cloud contract must accept exactly what the local
 * `AIProvider` receives, and return what it returns. If either side changes
 * without the other, `npm run typecheck` fails here instead of the two drifting.
 * Nothing in this file runs.
 */
import type { AskInput, AskOutput, ClassifyInput, DraftInput, RewriteInput, SummarizeInput } from '@pigeonbox/ai';
import type {
  AskInputSchema,
  AskOutputSchema,
  ClassifyInputSchema,
  DraftInputSchema,
  RewriteInputSchema,
  SummarizeInputSchema,
  VoiceProfileSchema,
} from '@pigeonbox/api-contract';
import type { VoiceProfile } from '@pigeonbox/shared';
import type { z } from 'zod';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type ContractCompat = [
  Assert<Equal<z.input<typeof ClassifyInputSchema>, ClassifyInput>>,
  Assert<Equal<z.input<typeof SummarizeInputSchema>, SummarizeInput>>,
  Assert<Equal<z.input<typeof DraftInputSchema>, DraftInput>>,
  Assert<Equal<z.input<typeof RewriteInputSchema>, RewriteInput>>,
  Assert<Equal<z.input<typeof AskInputSchema>, AskInput>>,
  Assert<Equal<z.infer<typeof AskOutputSchema>, AskOutput>>,
  Assert<Equal<z.input<typeof VoiceProfileSchema>, VoiceProfile>>,
];
