import { createMemoryRepositories } from '../src/repositories/memory.ts';
import { runRepositoryContract } from './repositories.contract.ts';

runRepositoryContract('in-memory', async () => createMemoryRepositories());
