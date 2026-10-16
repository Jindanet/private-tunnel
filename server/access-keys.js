const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^ptk_([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;
const MAX_KEYS = 10000;

function inputError(message) {
  return Object.assign(new Error(message), { code: 'EACCESSKEYINPUT' });
}

function validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[\x00-\x1f\x7f]/.test(name)) {
    throw inputError('Client name must contain 1–100 characters without control characters.');
  }
  return name.trim();
}

function validateId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw inputError('Invalid client key ID.');
  return id;
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function publicKey(key) {
  return { id: key.id, name: key.name, createdAt: key.createdAt, rotatedAt: key.rotatedAt, revokedAt: key.revokedAt };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function readRegistry(filePath, fileSystem) {
  let raw;
  try { raw = fileSystem.readFileSync(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error('Client access key registry is invalid. Restore a valid registry before starting.'); }
  const allowedFields = ['id', 'name', 'tokenHash', 'createdAt', 'rotatedAt', 'revokedAt'];
  const ids = new Set();
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1
    || Object.keys(data).some((field) => !['version', 'keys'].includes(field))
    || !Array.isArray(data.keys) || data.keys.length > MAX_KEYS) {
    throw new Error('Client access key registry is invalid. Restore a valid registry before starting.');
  }
  for (const key of data.keys) {
    if (!key || typeof key !== 'object' || Array.isArray(key) || !ID_PATTERN.test(key.id || '') || ids.has(key.id)
      || Object.keys(key).some((field) => !allowedFields.includes(field))
      || typeof key.name !== 'string' || !key.name.trim() || key.name.length > 100 || /[\x00-\x1f\x7f]/.test(key.name)
      || !/^[a-f0-9]{64}$/.test(key.tokenHash || '') || !isTimestamp(key.createdAt)
      || !(key.rotatedAt === null || isTimestamp(key.rotatedAt))
      || !(key.revokedAt === null || isTimestamp(key.revokedAt))) {
      throw new Error('Client access key registry is invalid. Restore a valid registry before starting.');
    }
    ids.add(key.id);
  }
  return data.keys;
}

// One store owns the registry in one server process. Only successful atomic writes
// replace the authenticated in-memory state; callers never receive stored hashes.
function createAccessKeyStore({ filePath, dataDir, fileSystem = fs } = {}) {
  const registryPath = path.resolve(filePath || path.join(dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'client-keys.json'));
  let keys = readRegistry(registryPath, fileSystem);
  let mutationQueue = Promise.resolve();

  function persist(nextKeys) {
    const directory = path.dirname(registryPath);
    fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fileSystem.chmodSync(directory, 0o700);
    const temporaryPath = `${registryPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fileSystem.openSync(temporaryPath, 'wx', 0o600);
      fileSystem.writeFileSync(descriptor, JSON.stringify({ version: 1, keys: nextKeys }, null, 2) + '\n', 'utf8');
      fileSystem.fsyncSync(descriptor);
      fileSystem.closeSync(descriptor);
      descriptor = undefined;
      fileSystem.renameSync(temporaryPath, registryPath);
    } catch (error) {
      if (descriptor !== undefined) try { fileSystem.closeSync(descriptor); } catch {}
      try { fileSystem.unlinkSync(temporaryPath); } catch {}
      throw error;
    }
    keys = nextKeys;
  }

  function mutate(operation) {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => {});
    return result;
  }

  function issue(name) {
    return mutate(() => {
      const checkedName = validateName(name);
      if (keys.length >= MAX_KEYS) throw inputError('The client key registry is full.');
      const id = crypto.randomUUID();
      const token = `ptk_${id}_${crypto.randomBytes(32).toString('base64url')}`;
      const key = { id, name: checkedName, tokenHash: hashToken(token), createdAt: new Date().toISOString(), rotatedAt: null, revokedAt: null };
      persist([...keys, key]);
      return { key: publicKey(key), token };
    });
  }

  function revoke(id) {
    return mutate(() => {
      validateId(id);
      const key = keys.find((item) => item.id === id);
      if (!key) return null;
      if (key.revokedAt) return publicKey(key);
      const revoked = { ...key, revokedAt: new Date().toISOString() };
      persist(keys.map((item) => item.id === id ? revoked : item));
      return publicKey(revoked);
    });
  }

  function rotate(id) {
    return mutate(() => {
      validateId(id);
      const key = keys.find((item) => item.id === id);
      if (!key) return null;
      if (key.revokedAt) throw inputError('A revoked client key cannot be rotated. Issue a new client key instead.');
      const token = `ptk_${id}_${crypto.randomBytes(32).toString('base64url')}`;
      const rotated = { ...key, tokenHash: hashToken(token), rotatedAt: new Date().toISOString() };
      persist(keys.map((item) => item.id === id ? rotated : item));
      return { key: publicKey(rotated), token };
    });
  }

  function authenticate(token) {
    if (typeof token !== 'string') return null;
    const match = TOKEN_PATTERN.exec(token);
    if (!match) return null;
    const key = keys.find((item) => item.id === match[1]);
    if (!key || key.revokedAt) return null;
    const candidate = Buffer.from(hashToken(token), 'hex');
    return crypto.timingSafeEqual(candidate, Buffer.from(key.tokenHash, 'hex')) ? publicKey(key) : null;
  }

  return { list: () => keys.map(publicKey), issue, revoke, rotate, authenticate };
}

module.exports = { createAccessKeyStore };
