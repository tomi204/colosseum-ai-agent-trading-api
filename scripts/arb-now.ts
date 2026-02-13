import { JupiterClient } from '../src/infra/live/jupiterClient.js';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

const RPC = process.env.SOLANA_RPC_URL!;
const KEY = process.env.SOLANA_PRIVATE_KEY_B58!;
const QUOTE = 'https://lite-api.jup.ag/swap/v1/quote';
const SWAP = 'https://lite-api.jup.ag/swap/v1/swap';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const JTO = 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL';
const JITOSOL = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
const RAY = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const MSOL = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';

const jup = new JupiterClient(QUOTE, SWAP, RPC, KEY, true);

interface Route {
  name: string;
  path: [string, string, string, string]; // A → B → C → A
  amounts: number[];
}

async function quoteRoute(input: string, output: string, amount: number): Promise<number | null> {
  try {
    const q = await jup.quote({ inputMint: input, outputMint: output, amount, slippageBps: 50 });
    return Number(q.outAmount) || null;
  } catch { return null; }
}

async function tryTriangle(name: string, a: string, b: string, c: string, startAmount: number): Promise<{name: string, profit: number, profitPct: number, amounts: number[]} | null> {
  const leg1 = await quoteRoute(a, b, startAmount);
  if (!leg1) return null;
  
  const leg2 = await quoteRoute(b, c, leg1);
  if (!leg2) return null;
  
  const leg3 = await quoteRoute(c, a, leg2);
  if (!leg3) return null;
  
  const profit = leg3 - startAmount;
  const profitPct = (profit / startAmount) * 100;
  
  return { name, profit, profitPct, amounts: [startAmount, leg1, leg2, leg3] };
}

async function executeTriangle(a: string, b: string, c: string, startAmount: number): Promise<string[]> {
  const txs: string[] = [];
  
  // Leg 1
  const q1 = await jup.quote({ inputMint: a, outputMint: b, amount: startAmount, slippageBps: 100 });
  const r1 = await jup.swapFromQuote(q1);
  if (r1.txSignature) { txs.push(r1.txSignature); console.log(`   Leg1 ✅ ${r1.txSignature}`); }
  else { console.log('   Leg1 ⚠️ simulated'); return txs; }
  
  await new Promise(r => setTimeout(r, 2000));
  
  const outAmount1 = Number(q1.outAmount);
  
  // Leg 2
  const q2 = await jup.quote({ inputMint: b, outputMint: c, amount: outAmount1, slippageBps: 100 });
  const r2 = await jup.swapFromQuote(q2);
  if (r2.txSignature) { txs.push(r2.txSignature); console.log(`   Leg2 ✅ ${r2.txSignature}`); }
  else { console.log('   Leg2 ⚠️ simulated'); return txs; }
  
  await new Promise(r => setTimeout(r, 2000));
  
  const outAmount2 = Number(q2.outAmount);
  
  // Leg 3
  const q3 = await jup.quote({ inputMint: c, outputMint: a, amount: outAmount2, slippageBps: 100 });
  const r3 = await jup.swapFromQuote(q3);
  if (r3.txSignature) { txs.push(r3.txSignature); console.log(`   Leg3 ✅ ${r3.txSignature}`); }
  else { console.log('   Leg3 ⚠️ simulated'); }
  
  return txs;
}

async function main() {
  const connection = new Connection(RPC, 'confirmed');
  const keypair = Keypair.fromSecretKey(bs58.decode(KEY));
  const bal = await connection.getBalance(keypair.publicKey);
  console.log(`💰 Balance: ${(bal / LAMPORTS_PER_SOL).toFixed(6)} SOL\n`);

  // Use ~0.05 SOL per attempt to limit risk
  const INPUT = Math.floor(0.05 * LAMPORTS_PER_SOL);

  console.log('🔍 Scanning triangle arbitrage routes...\n');
  
  const routes = [
    { name: 'SOL→USDC→BONK→SOL', a: SOL, b: USDC, c: BONK },
    { name: 'SOL→BONK→USDC→SOL', a: SOL, b: BONK, c: USDC },
    { name: 'SOL→USDC→WIF→SOL', a: SOL, b: USDC, c: WIF },
    { name: 'SOL→WIF→USDC→SOL', a: SOL, b: WIF, c: USDC },
    { name: 'SOL→USDC→JTO→SOL', a: SOL, b: USDC, c: JTO },
    { name: 'SOL→JTO→USDC→SOL', a: SOL, b: JTO, c: USDC },
    { name: 'SOL→USDC→RAY→SOL', a: SOL, b: USDC, c: RAY },
    { name: 'SOL→RAY→USDC→SOL', a: SOL, b: RAY, c: USDC },
    { name: 'SOL→MSOL→USDC→SOL', a: SOL, b: MSOL, c: USDC },
    { name: 'SOL→JITOSOL→USDC→SOL', a: SOL, b: JITOSOL, c: USDC },
    { name: 'SOL→BONK→WIF→SOL', a: SOL, b: BONK, c: WIF },
    { name: 'SOL→WIF→BONK→SOL', a: SOL, b: WIF, c: BONK },
  ];

  const results: {name: string, profit: number, profitPct: number, amounts: number[], route: typeof routes[0]}[] = [];

  for (const route of routes) {
    const r = await tryTriangle(route.name, route.a, route.b, route.c, INPUT);
    if (r) {
      console.log(`   ${r.name}: ${r.profitPct > 0 ? '🟢' : '🔴'} ${r.profitPct.toFixed(4)}% (${r.profit} lamports)`);
      results.push({ ...r, route });
    } else {
      console.log(`   ${route.name}: ❌ quote failed`);
    }
  }

  // Sort by profit
  results.sort((a, b) => b.profitPct - a.profitPct);

  console.log('\n━'.repeat(60));
  console.log('📊 Best routes:');
  for (const r of results.slice(0, 5)) {
    console.log(`   ${r.profitPct > 0 ? '🟢' : '🔴'} ${r.name}: ${r.profitPct.toFixed(4)}% (${r.profit > 0 ? '+' : ''}${(r.profit / LAMPORTS_PER_SOL).toFixed(8)} SOL)`);
  }

  // Execute best profitable route if any
  const profitable = results.filter(r => r.profitPct > 0.01); // > 0.01% profit threshold
  
  if (profitable.length > 0) {
    const best = profitable[0];
    console.log(`\n🚀 Executing best route: ${best.name} (${best.profitPct.toFixed(4)}%)`);
    const txs = await executeTriangle(best.route.a, best.route.b, best.route.c, INPUT);
    console.log(`   Executed ${txs.length}/3 legs`);
  } else {
    console.log('\n⚠️ No profitable routes found above threshold (0.01%)');
    console.log('   Jupiter already optimizes routes, making triangle arb hard.');
    console.log('   Executing best route anyway for demonstration...');
    
    if (results.length > 0) {
      const best = results[0];
      console.log(`\n🔄 Running: ${best.name} (${best.profitPct.toFixed(4)}%)`);
      const txs = await executeTriangle(best.route.a, best.route.b, best.route.c, INPUT);
      console.log(`   Executed ${txs.length}/3 legs`);
    }
  }

  // Final balance
  await new Promise(r => setTimeout(r, 2000));
  const finalBal = await connection.getBalance(keypair.publicKey);
  console.log(`\n💰 Final: ${(finalBal / LAMPORTS_PER_SOL).toFixed(6)} SOL (delta: ${((finalBal - bal) / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
}

main().catch(console.error);
