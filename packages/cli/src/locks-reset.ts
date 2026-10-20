/** Tests: release every lock this process holds and forget the shutdown handlers (S8). */
import { resetActorsForTests } from './actor-lock.js';
import { resetHeavyForTests } from './heavy-lock.js';
import { resetShutdownForTests } from './shutdown.js';

export function resetLocksForTests(): void {
  resetActorsForTests();
  resetHeavyForTests();
  resetShutdownForTests();
}
