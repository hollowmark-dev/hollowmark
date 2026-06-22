// Devnet smoke test for the FULL mechanism set:
//   enter_run (fee->treasury + stake->vault) -> forfeit_run (death: stake->treasury).
// Uses the deployer as the "player". Run: node onchain/scripts/smoke.mjs
import { readFileSync } from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL
} from "@solana/web3.js";

const PID = new PublicKey("CRMmDMi1VXyfGAuKig9NTFta23QbNAQwTqzrSjxJG9rz");
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const player = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL("../keys/deployer.json", import.meta.url)))));
const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), player.publicKey.toBuffer()], PID);
const [treasury] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], PID);

const FEE = Math.round(0.005 * LAMPORTS_PER_SOL), STAKE = Math.round(0.005 * LAMPORTS_PER_SOL);
const enterData = (stake, fee, cls) => { const b = Buffer.alloc(18); b.writeUInt8(1,0); b.writeBigUInt64LE(BigInt(stake),1); b.writeBigUInt64LE(BigInt(fee),9); b.writeUInt8(cls,17); return b; };
const forfeitData = (depth) => { const b = Buffer.alloc(3); b.writeUInt8(3,0); b.writeUInt16LE(depth,1); return b; };

function decodeVault(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); let o = 32;
  const f = () => { const v = dv.getUint8(o); o += 1; return v; };
  const u16 = () => { const v = dv.getUint16(o, true); o += 2; return v; };
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const u64 = () => { const v = dv.getBigUint64(o, true); o += 8; return v.toString(); };
  return { in_run: f(), cls: f(), depth: u16(), stake: u64(), runs: u32(), extracts: u32(), deaths: u32(), banked: u64(), lost: u64() };
}
const send = (data, keys) => sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ programId: PID, keys, data })), [player], { commitment: "confirmed" });
const sol = (lp) => (lp / LAMPORTS_PER_SOL).toFixed(4);

const P = { pubkey: player.publicKey, isSigner: true, isWritable: true };
const V = { pubkey: vault, isSigner: false, isWritable: true };
const T = { pubkey: treasury, isSigner: false, isWritable: true };
const S = { pubkey: SystemProgram.programId, isSigner: false, isWritable: false };

console.log("player:", player.publicKey.toBase58());
console.log("treasury:", treasury.toBase58());
const tBefore = await conn.getBalance(treasury);
console.log("treasury balance before:", sol(tBefore), "SOL");

console.log("\n→ enter_run(stake=0.005, fee=0.005, class=1)  [fee burns to treasury, stake escrows]");
console.log("  tx:", await send(enterData(STAKE, FEE, 1), [P, V, T, S]));
console.log("  vault:", decodeVault((await conn.getAccountInfo(vault)).data));
console.log("  treasury balance:", sol(await conn.getBalance(treasury)), "SOL  (expect +fee)");

console.log("\n→ forfeit_run(depth=2)  [death: stake swept to treasury]");
console.log("  tx:", await send(forfeitData(2), [P, V, T]));
console.log("  vault:", decodeVault((await conn.getAccountInfo(vault)).data));
const tAfter = await conn.getBalance(treasury);
console.log("  treasury balance after:", sol(tAfter), "SOL");
console.log("\nΔ treasury =", sol(tAfter - tBefore), "SOL  (expect ≈ fee + stake = 0.0100)");
