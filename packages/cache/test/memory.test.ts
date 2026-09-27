import { createMemoryCacheTier } from '../src/memory.ts';
import { runCacheTierContract } from './contract.ts';

runCacheTierContract('in-memory', () => createMemoryCacheTier());
