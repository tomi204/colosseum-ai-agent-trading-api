import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import {
  deriveWalletAddressFromEnvObject,
  deriveWalletAddressFromPrivateKey,
  resolveRuntimeWalletPublicMetadata,
} from '../src/integrations/clawpump/wallet.js';

describe('clawpump wallet utilities', () => {
  it('derives public key from base58 secret key', () => {
    const keypair = Keypair.generate();
    const privateKey = bs58.encode(keypair.secretKey);

    const address = deriveWalletAddressFromPrivateKey(privateKey);

    expect(address).toBe(keypair.publicKey.toBase58());
  });

  it('derives public key from json array secret key', () => {
    const keypair = Keypair.generate();
    const privateKey = JSON.stringify(Array.from(keypair.secretKey));

    const address = deriveWalletAddressFromPrivateKey(privateKey);

    expect(address).toBe(keypair.publicKey.toBase58());
  });

  it('prefers CLAWPUMP_WALLET_ADDRESS over private key fallback', () => {
    const preferred = Keypair.generate().publicKey.toBase58();

    const wallet = deriveWalletAddressFromEnvObject({
      CLAWPUMP_WALLET_ADDRESS: preferred,
      SOLANA_PRIVATE_KEY: 'this-value-should-not-be-used',
    });

    expect(wallet.configured).toBe(true);
    expect(wallet.source).toBe('CLAWPUMP_WALLET_ADDRESS');
    expect(wallet.address).toBe(preferred);
  });

  it('marks runtime metadata as unconfigured when wallet env is missing', () => {
    const metadata = resolveRuntimeWalletPublicMetadata({});

    expect(metadata.configured).toBe(false);
    expect(metadata.source).toBe('unconfigured');
  });
});
