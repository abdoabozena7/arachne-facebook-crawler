import type { CrawlState } from './types.js';
const transitions: Record<CrawlState, CrawlState[]> = {
  idle: ['starting'], starting: ['running', 'waiting_login', 'paused', 'stopping', 'failed'],
  running: ['paused', 'waiting_login', 'stopping', 'completed', 'failed'],
  paused: ['running', 'waiting_login', 'stopping', 'failed'],
  waiting_login: ['running', 'stopping', 'failed'], stopping: ['stopped', 'failed'],
  completed: ['starting'], stopped: ['starting'], failed: ['starting']
};
export class StateMachine {
  state: CrawlState = 'idle';
  transition(next: CrawlState): void {
    if (!transitions[this.state].includes(next)) throw new Error(`Cannot ${next} from ${this.state}`);
    this.state = next;
  }
  get active(): boolean { return ['starting', 'running', 'paused', 'waiting_login', 'stopping'].includes(this.state); }
}
