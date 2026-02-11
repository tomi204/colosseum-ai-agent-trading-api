import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export type WalletMetadataSource = 'CLAWPUMP_WALLET_ADDRESS' | 'derived_local_dev' | 'unconfigured';

export interface WalletPublicMetadata {
  configured: boolean;
  source: WalletMetadataSource;
  address?: string;
  warning?: string;
}

const parseSecretKey = (privateKeyRaw: string): Uint8Array => {
  const trimmed = privateKeyRaw.trim();

  if (!trimmed) {
    throw new Error('Private key is empty.');
  }

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('Private key JSON must be an array of bytes.');
    }

    return Uint8Array.from(parsed.map((value) => Number(value)));
  }

  if (trimmed.includes(',') && /^[\d\s,]+$/.test(trimmed)) {
    const parts = trimmed.split(',').map((part) => Number(part.trim()));
    return Uint8Array.from(parts);
  }

  return bs58.decode(trimmed);
};

const toPublicAddress = (address: string): string => new PublicKey(address).toBase58();

export const deriveWalletAddressFromPrivateKey = (privateKeyRaw: string): string => {
  let secretKey: Uint8Array;

  try {
    secretKey = parseSecretKey(privateKeyRaw);
  } catch {
    throw new Error('Unable to parse SOLANA private key format.');
  }

  try {
    if (secretKey.length === 64) {
      return Keypair.fromSecretKey(secretKey).publicKey.toBase58();
    }

    if (secretKey.length === 32) {
      return Keypair.fromSeed(secretKey).publicKey.toBase58();
    }
  } catch {
    throw new Error('Unable to derive public key from provided SOLANA private key.');
  }

  throw new Error('Unsupported private key length. Expected 32-byte seed or 64-byte secret key.');
};

export const resolveRuntimeWalletPublicMetadata = (env: NodeJS.ProcessEnv): WalletPublicMetadata => {
  const configuredAddress = env.CLAWPUMP_WALLET_ADDRESS?.trim();

  if (!configuredAddress) {
    return {
      configured: false,
      source: 'unconfigured',
      warning: 'CLAWPUMP_WALLET_ADDRESS is not set.',
    };
  }

  try {
    return {
      configured: true,
      source: 'CLAWPUMP_WALLET_ADDRESS',
      address: toPublicAddress(configuredAddress),
    };
  } catch {
    return {
      configured: false,
      source: 'unconfigured',
      warning: 'CLAWPUMP_WALLET_ADDRESS is set but invalid.',
    };
  }
};

export const deriveWalletAddressFromEnvObject = (env: Record<string, string | undefined>): WalletPublicMetadata => {
  const configuredAddress = env.CLAWPUMP_WALLET_ADDRESS?.trim();

  if (configuredAddress) {
    return {
      configured: true,
      source: 'CLAWPUMP_WALLET_ADDRESS',
      address: toPublicAddress(configuredAddress),
    };
  }

  const privateKey = env.SOLANA_PRIVATE_KEY?.trim() ?? env.SOLANA_PRIVATE_KEY_B58?.trim();

  if (!privateKey) {
    throw new Error('Neither CLAWPUMP_WALLET_ADDRESS nor SOLANA_PRIVATE_KEY is available in env file.');
  }

  return {
    configured: true,
    source: 'derived_local_dev',
    address: deriveWalletAddressFromPrivateKey(privateKey),
  };
};
