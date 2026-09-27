import { createMemoryRepositories } from '../src/repositories/memory.ts';
import { seedMemoryGeography } from '../src/seed-memory.ts';
import { runForumContract } from './forum.contract.ts';
import { runRepositoryContract } from './repositories.contract.ts';

runRepositoryContract('in-memory', async () => createMemoryRepositories());
runForumContract('in-memory', async () => {
  // Seeded like the Postgres catalogue, so the contract runs against real region keys either way.
  const repos = createMemoryRepositories();
  seedMemoryGeography(repos.catalogue);
  return repos;
});
