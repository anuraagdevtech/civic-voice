import { createMemoryRepositories } from '../src/repositories/memory.ts';
import { runForumContract } from './forum.contract.ts';
import { runRepositoryContract } from './repositories.contract.ts';

runRepositoryContract('in-memory', async () => createMemoryRepositories());
runForumContract('in-memory', async () => createMemoryRepositories());
