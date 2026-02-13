import { JupiterClient } from '../src/infra/live/jupiterClient.js';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

const RPC = process.env.SOLANA_RPC_URL!;
const KEY = process.env.SOLANA_PRIVATE_KEY_B58!;
const jup = new JupiterClient(
  'https://lite-api.jup.ag/swap/v1/quote',
  'https://lite-api.jup.ag/swap/v1/swap',
  RPC, KEY, true,
);

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const MSOL = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';

// Higher slippage for speed
const SLIPPAGE = 300; // 3%

async function doSwap(label: string, inputMint: string, outputMint: string, amount: number): Promise<{sig: string | null, out: number}> {
  const q = await jup.quote({ inputMint, outputMint, amount, slippageBps: SLIPPAGE });
  const r = await jup.swapFromQuote(q);
  const out = Number(q.outAmount) || 0;
  if (r.txSignature) {
    console.log(`  ${label} ✅ ${r.txSignature.slice(0, 20)}... (out: ${out})`);
    return { sig: r.txSignature, out };
  }
  console.log(`  ${label} ⚠️ simulated`);
  return { sig: null, out };
}

async function main() {
  const connection = new Connection(RPC, 'confirmed');
  const kp = Keypair.fromSecretKey(bs58.decode(KEY));
  const startBal = await connection.getBalance(kp.publicKey);
  console.log(`💰 ${(startBal / LAMPORTS_PER_SOL).toFixed(6)} SOL\n`);

  // Run multiple direct swaps fast — less slippage risk than triangles
  const INPUT = Math.floor(0.03 * LAMPORTS_PER_SOL); // 0.03 SOL each

  // Round 1: SOL → USDC → SOL (direct roundtrip via different routes)
  console.log('🔄 Round 1: SOL → USDC → SOL');
  try {
    const r1 = await doSwap('SOL→USDC', SOL, USDC, INPUT);
    await new Promise(r => setTimeout(r, 1500));
    if (r1.out > 0) {
      await doSwap('USDC→SOL', USDC, SOL, r1.out);
    }
  } catch (e: any) { console.log(`  ❌ ${e.message}`); }

  await new Promise(r => setTimeout(r, 1500));

  // Round 2: SOL → mSOL → SOL (liquid staking arb)
  console.log('\n🔄 Round 2: SOL → mSOL → SOL (staking arb)');
  try {
    const r2 = await doSwap('SOL→mSOL', SOL, MSOL, INPUT);
    await new Promise(r => setTimeout(r, 1500));
    if (r2.out > 0) {
      await doSwap('mSOL→SOL', MSOL, SOL, r2.out);
    }
  } catch (e: any) { console.log(`  ❌ ${e.message}`); }

  await new Promise(r => setTimeout(r, 1500));

  // Round 3: SOL → WIF → SOL
  console.log('\n🔄 Round 3: SOL → WIF → SOL');
  try {
    const r3 = await doSwap('SOL→WIF', SOL, WIF, INPUT);
    await new Promise(r => setTimeout(r, 1500));
    if (r3.out > 0) {
      await doSwap('WIF→SOL', WIF, SOL, r3.out);
    }
  } catch (e: any) { console.log(`  ❌ ${e.message}`); }

  // Final
  await new Promise(r => setTimeout(r, 2000));
  const endBal = await connection.getBalance(kp.publicKey);
  const delta = endBal - startBal;
  console.log(`\n💰 End: ${(endBal / LAMPORTS_PER_SOL).toFixed(6)} SOL | Delta: ${delta > 0 ? '+' : ''}${(delta / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
}

main().catch(console.error);
