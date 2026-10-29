// The product is nuworq. It used to be called Trellis, and setups from then keep working: wherever
// a name is read (environment, project config, data folder, and in their own files: headers,
// cookie, tokens, worker branches), the old name still counts. Everything new uses the new one.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// NUWORQ_<key>, else the old TRELLIS_<key>. from: the environment to read (default: this process's).
export const envVar = (key, from = process.env) => from[`NUWORQ_${key}`] ?? from[`TRELLIS_${key}`];

// A folder's project config: .nuworq.json wins over an older .trellis.json in the same folder.
export const CONFIG_FILES = ['.nuworq.json', '.trellis.json'];

// Where the hub keeps its files: ~/.nuworq, or an existing ~/.trellis while there is no ~/.nuworq.
// Nothing is moved: rename the folder yourself (with the hub stopped) whenever you like.
export function dataDir(home = homedir()) {
  const dir = join(home, '.nuworq'), old = join(home, '.trellis');
  return !existsSync(dir) && existsSync(old) ? old : dir;
}

// The default database in that folder: nuworq.db, or the trellis.db it already holds
// (including after ~/.trellis was renamed to ~/.nuworq with the file inside unchanged).
export function defaultDb(home = homedir()) {
  const dir = dataDir(home);
  const db = join(dir, 'nuworq.db'), old = join(dir, 'trellis.db');
  return !existsSync(db) && existsSync(old) ? old : db;
}
