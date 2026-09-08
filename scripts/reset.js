// Wipe local state (threads, ledgers, discounts) so a demo starts clean.
import fs from 'node:fs';

fs.rmSync('data', { recursive: true, force: true });
console.log('state cleared — next boot starts with fresh threads, ledgers, and discounts');
