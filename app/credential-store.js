const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STORAGE_ERROR = 'Secure credential storage is unavailable. Unlock your operating system credential store, restart PrivateTunnel, then re-enter the access key. The key was not saved.';
const UNLOCK_ERROR = 'The saved access key could not be unlocked. Unlock your operating system credential store and re-enter the key in Settings.';

function createCredentialStore({ configPath, legacyPath = null, importLegacy = true, safeStorage,
  isReady, platform = process.platform, fs: fileSystem = fs }) {
  const destination = path.resolve(configPath);
  const legacy = legacyPath && path.resolve(legacyPath);
  if (legacy && destination.toLowerCase() === legacy.toLowerCase()) {
    throw new Error('The desktop profile must use a different file from the CLI profile. Remove PTUNNEL_CONFIG_PATH or choose another path.');
  }

  function assertReady() {
    if (!isReady()) throw new Error('Desktop credentials cannot be loaded or saved before Electron is ready.');
  }

  function getAvailabilityError() {
    if (!isReady()) return STORAGE_ERROR;
    try {
      if (!safeStorage?.isEncryptionAvailable()) return STORAGE_ERROR;
      if (platform === 'linux' && !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(safeStorage.getSelectedStorageBackend())) {
        return 'Secure credential storage requires a Linux system keyring (Secret Service or KWallet). Enable and unlock the keyring, restart PrivateTunnel, then re-enter the access key. The key was not saved.';
      }
      return null;
    } catch {
      return STORAGE_ERROR;
    }
  }

  function withoutCredential(profile) {
    const result = { ...profile };
    delete result.token;
    delete result.credential;
    delete result.credentialStorageError;
    return result;
  }

  function write(profile) {
    const temporary = `${destination}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    fileSystem.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
      fileSystem.writeFileSync(temporary, JSON.stringify(profile, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fileSystem.renameSync(temporary, destination);
      if (platform !== 'win32') fileSystem.chmodSync(destination, 0o600);
    } finally {
      try { fileSystem.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  function save(profile) {
    assertReady();
    const disk = withoutCredential(profile);
    let token = typeof profile.token === 'string' ? profile.token.trim() : '';
    let credentialStorageError = null;
    if (token) {
      credentialStorageError = getAvailabilityError();
      if (!credentialStorageError) {
        try {
          const encrypted = safeStorage.encryptString(token);
          if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('Invalid encrypted credential');
          disk.credential = { version: 1, ciphertext: encrypted.toString('base64') };
        } catch {
          credentialStorageError = STORAGE_ERROR;
        }
      }
      if (credentialStorageError) token = '';
    }
    write(disk);
    return { config: { ...withoutCredential(profile), token: token || null }, credentialStorageError };
  }

  function read(filename) {
    try {
      const value = JSON.parse(fileSystem.readFileSync(filename, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid desktop profile');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function load() {
    assertReady();
    const profile = read(destination) || (importLegacy && legacy ? read(legacy) : null) || {};
    let token = typeof profile.token === 'string' ? profile.token.trim() : '';
    let credentialStorageError = null;
    if (Object.prototype.hasOwnProperty.call(profile, 'credential')) {
      token = '';
      credentialStorageError = getAvailabilityError();
      if (!credentialStorageError) {
        try {
          const credential = profile.credential;
          if (credential?.version !== 1 || typeof credential.ciphertext !== 'string'
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(credential.ciphertext)
            || !credential.ciphertext.length) throw new Error('Invalid saved credential');
          token = safeStorage.decryptString(Buffer.from(credential.ciphertext, 'base64'));
          if (typeof token !== 'string' || !token.trim()) throw new Error('Invalid saved credential');
        } catch {
          credentialStorageError = UNLOCK_ERROR;
        }
      }
    }
    const saved = save({ ...withoutCredential(profile), token });
    return { ...saved, credentialStorageError: saved.credentialStorageError || credentialStorageError };
  }

  return { load, save, getAvailabilityError };
}

module.exports = { createCredentialStore };
