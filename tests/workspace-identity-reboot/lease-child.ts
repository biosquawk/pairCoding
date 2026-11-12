import path from 'node:path';
import { JournalLease } from '../../src/server/runtime-coordinator/JournalLease';
const lease = new JournalLease(path.join(process.argv[2], '.paircoach/workspace-v2/lease.lock'));
process.stdout.write('OWNED\n');
process.stdin.once('data', () => { lease.close(); process.exit(0); });
