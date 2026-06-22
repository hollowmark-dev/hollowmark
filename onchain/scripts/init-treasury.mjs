// One-time: create the singleton Grave treasury PDA (InitTreasury, tag 0).
// Run: node onchain/scripts/init-treasury.mjs
import { readFileSync } from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction
} from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("CRMmDMi1VXyfGAuKig9NTFta23QbNAQwTqzrSjxJG9rz");
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

const secret = JSON.parse(readFileSync(new URL("../keys/deployer.json", import.meta.url)));
const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

const [treasury] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], PROGRAM_ID);
console.log("payer    :", payer.publicKey.toBase58());
console.log("treasury :", treasury.toBase58());

const info = await conn.getAccountInfo(treasury);
if (info) { console.log("treasury already initialised — nothing to do."); process.exit(0); }

const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: treasury, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
  ],
  data: Buffer.from([0]) // InitTreasury
});

const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], { commitment: "confirmed" });
console.log("InitTreasury tx:", sig);
console.log("explorer:", `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
