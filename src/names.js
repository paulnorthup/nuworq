// Where nuworq's own names are read: its environment variables, project config file and data folder.
import { join } from 'node:path';
import { homedir } from 'node:os';

// NUWORQ_<key>. from: the environment to read (default: this process's).
export const envVar = (key, from = process.env) => from[`NUWORQ_${key}`];

// A folder's project config.
export const CONFIG_FILE = '.nuworq.json';

// Where the hub keeps its files.
export const dataDir = (home = homedir()) => join(home, '.nuworq');

// The default database in that folder.
export const defaultDb = (home = homedir()) => join(dataDir(home), 'nuworq.db');
