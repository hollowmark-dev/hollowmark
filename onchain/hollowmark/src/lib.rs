//! Hollowmark — on-chain extraction-roguelite vault (devnet).
//!
//! The economic loop from FLYWHEEL.md, enforced on-chain:
//!   * `EnterRun`   — escrow a stake (lamports) into the player's vault PDA.
//!   * `ExtractRun` — survived: the escrow is returned to the player.
//!   * `ForfeitRun` — died: the escrow is swept to the Grave treasury (death tax).
//!
//! The vault PDA also keeps verifiable per-player stats (runs / extracts / deaths /
//! banked / lost). This is the native-Solana T1 of the Anchor design — same PDAs,
//! same guarantees, portable to the Anchor framework later.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

solana_program::declare_id!("CRMmDMi1VXyfGAuKig9NTFta23QbNAQwTqzrSjxJG9rz");

const TREASURY_SEED: &[u8] = b"treasury";
const VAULT_SEED: &[u8] = b"vault";

// ---------------------------------------------------------------- state

#[derive(BorshSerialize, BorshDeserialize, Default)]
pub struct Treasury {
    pub total_swept: u64, // lamports collected from deaths
    pub bump: u8,
}
impl Treasury {
    pub const LEN: usize = 8 + 1;
}

#[derive(BorshSerialize, BorshDeserialize, Default)]
pub struct PlayerVault {
    pub owner: Pubkey,
    pub in_run: u8, // 0 idle, 1 in a run
    pub class: u8,
    pub depth: u16,
    pub stake: u64, // lamports currently escrowed
    pub runs: u32,
    pub extracts: u32,
    pub deaths: u32,
    pub banked: u64, // cumulative haul booked on extract (score units)
    pub lost: u64,   // cumulative stake swept on death
    pub bump: u8,
}
impl PlayerVault {
    pub const LEN: usize = 32 + 1 + 1 + 2 + 8 + 4 + 4 + 4 + 8 + 8 + 1;
}

// ---------------------------------------------------------------- instructions

#[derive(BorshSerialize, BorshDeserialize)]
pub enum Instruction {
    /// Create the singleton Grave treasury PDA. Accounts: [payer(s,w), treasury(w), system].
    InitTreasury,
    /// Pay to enter: `fee` lamports burned to the treasury (non-refundable house cut)
    /// + `stake` lamports escrowed into the caller's vault (returned on extract, swept
    /// on death). Accounts: [player(s,w), vault(w), treasury(w), system].
    EnterRun { stake: u64, fee: u64, class: u8 },
    /// Survived — return the escrow. Accounts: [player(s,w), vault(w)].
    ExtractRun { depth: u16, haul: u64 },
    /// Died — sweep the escrow to the treasury. Accounts: [player(s,w), vault(w), treasury(w)].
    ForfeitRun { depth: u16 },
}

entrypoint!(process);

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match Instruction::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)? {
        Instruction::InitTreasury => init_treasury(program_id, accounts),
        Instruction::EnterRun { stake, fee, class } => enter_run(program_id, accounts, stake, fee, class),
        Instruction::ExtractRun { depth, haul } => extract_run(program_id, accounts, depth, haul),
        Instruction::ForfeitRun { depth } => forfeit_run(program_id, accounts, depth),
    }
}

// ---------------------------------------------------------------- handlers

fn init_treasury(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let payer = next_account_info(ai)?;
    let treasury = next_account_info(ai)?;
    let system = next_account_info(ai)?;

    let (pda, bump) = Pubkey::find_program_address(&[TREASURY_SEED], program_id);
    if pda != *treasury.key {
        return Err(ProgramError::InvalidSeeds);
    }
    if !treasury.data_is_empty() {
        return Ok(()); // already initialised — idempotent
    }
    create_pda(
        payer,
        treasury,
        system,
        program_id,
        Treasury::LEN,
        &[TREASURY_SEED, &[bump]],
    )?;
    let t = Treasury { total_swept: 0, bump };
    t.serialize(&mut &mut treasury.data.borrow_mut()[..])?;
    Ok(())
}

fn enter_run(program_id: &Pubkey, accounts: &[AccountInfo], stake: u64, fee: u64, class: u8) -> ProgramResult {
    let ai = &mut accounts.iter();
    let player = next_account_info(ai)?;
    let vault = next_account_info(ai)?;
    let treasury = next_account_info(ai)?;
    let system = next_account_info(ai)?;

    if !player.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (pda, bump) = Pubkey::find_program_address(&[VAULT_SEED, player.key.as_ref()], program_id);
    let (tpda, _tb) = Pubkey::find_program_address(&[TREASURY_SEED], program_id);
    if pda != *vault.key || tpda != *treasury.key || treasury.owner != program_id {
        return Err(ProgramError::InvalidSeeds);
    }

    // create the vault on first entry
    if vault.data_is_empty() {
        create_pda(
            player,
            vault,
            system,
            program_id,
            PlayerVault::LEN,
            &[VAULT_SEED, player.key.as_ref(), &[bump]],
        )?;
        let v = PlayerVault {
            owner: *player.key,
            bump,
            ..Default::default()
        };
        v.serialize(&mut &mut vault.data.borrow_mut()[..])?;
    }

    let mut v = PlayerVault::try_from_slice(&vault.data.borrow())?;
    if v.owner != *player.key {
        return Err(ProgramError::IllegalOwner);
    }
    if v.in_run != 0 {
        return Err(ProgramError::Custom(1)); // already in a run
    }

    // escrow the stake: player -> vault (player signs, ordinary transfer)
    if stake > 0 {
        solana_program::program::invoke(
            &system_instruction::transfer(player.key, vault.key, stake),
            &[player.clone(), vault.clone(), system.clone()],
        )?;
    }

    // burn the entry fee to the Grave treasury (non-refundable house cut)
    if fee > 0 {
        solana_program::program::invoke(
            &system_instruction::transfer(player.key, treasury.key, fee),
            &[player.clone(), treasury.clone(), system.clone()],
        )?;
        let mut t = Treasury::try_from_slice(&treasury.data.borrow())?;
        t.total_swept = t.total_swept.saturating_add(fee);
        t.serialize(&mut &mut treasury.data.borrow_mut()[..])?;
    }

    v.in_run = 1;
    v.class = class;
    v.depth = 1;
    v.stake = stake;
    v.runs = v.runs.saturating_add(1);
    v.serialize(&mut &mut vault.data.borrow_mut()[..])?;
    Ok(())
}

fn extract_run(program_id: &Pubkey, accounts: &[AccountInfo], depth: u16, haul: u64) -> ProgramResult {
    let ai = &mut accounts.iter();
    let player = next_account_info(ai)?;
    let vault = next_account_info(ai)?;

    if !player.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (pda, _bump) = Pubkey::find_program_address(&[VAULT_SEED, player.key.as_ref()], program_id);
    if pda != *vault.key || vault.owner != program_id {
        return Err(ProgramError::InvalidSeeds);
    }
    let mut v = PlayerVault::try_from_slice(&vault.data.borrow())?;
    if v.owner != *player.key || v.in_run == 0 {
        return Err(ProgramError::Custom(2)); // not in a run
    }

    // survived — return the escrow (vault is program-owned: debit its lamports directly)
    let stake = v.stake;
    if stake > 0 {
        **vault.try_borrow_mut_lamports()? = vault
            .lamports()
            .checked_sub(stake)
            .ok_or(ProgramError::InsufficientFunds)?;
        **player.try_borrow_mut_lamports()? = player.lamports().checked_add(stake).unwrap();
    }

    v.in_run = 0;
    v.stake = 0;
    v.depth = depth;
    v.extracts = v.extracts.saturating_add(1);
    v.banked = v.banked.saturating_add(haul);
    v.serialize(&mut &mut vault.data.borrow_mut()[..])?;
    Ok(())
}

fn forfeit_run(program_id: &Pubkey, accounts: &[AccountInfo], depth: u16) -> ProgramResult {
    let ai = &mut accounts.iter();
    let player = next_account_info(ai)?;
    let vault = next_account_info(ai)?;
    let treasury = next_account_info(ai)?;

    if !player.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (vpda, _b) = Pubkey::find_program_address(&[VAULT_SEED, player.key.as_ref()], program_id);
    let (tpda, _tb) = Pubkey::find_program_address(&[TREASURY_SEED], program_id);
    if vpda != *vault.key || tpda != *treasury.key || vault.owner != program_id || treasury.owner != program_id {
        return Err(ProgramError::InvalidSeeds);
    }
    let mut v = PlayerVault::try_from_slice(&vault.data.borrow())?;
    if v.owner != *player.key || v.in_run == 0 {
        return Err(ProgramError::Custom(2));
    }

    // died — sweep the escrow to the Grave treasury (death tax)
    let stake = v.stake;
    if stake > 0 {
        **vault.try_borrow_mut_lamports()? = vault
            .lamports()
            .checked_sub(stake)
            .ok_or(ProgramError::InsufficientFunds)?;
        **treasury.try_borrow_mut_lamports()? = treasury.lamports().checked_add(stake).unwrap();
        let mut t = Treasury::try_from_slice(&treasury.data.borrow())?;
        t.total_swept = t.total_swept.saturating_add(stake);
        t.serialize(&mut &mut treasury.data.borrow_mut()[..])?;
    }

    v.in_run = 0;
    v.stake = 0;
    v.depth = depth;
    v.deaths = v.deaths.saturating_add(1);
    v.lost = v.lost.saturating_add(stake);
    v.serialize(&mut &mut vault.data.borrow_mut()[..])?;
    Ok(())
}

// ---------------------------------------------------------------- helpers

/// Create a rent-exempt, program-owned PDA of `space` bytes.
fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    pda: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    owner: &Pubkey,
    space: usize,
    seeds: &[&[u8]],
) -> ProgramResult {
    let lamports = Rent::get()?.minimum_balance(space);
    invoke_signed(
        &system_instruction::create_account(payer.key, pda.key, lamports, space as u64, owner),
        &[payer.clone(), pda.clone(), system.clone()],
        &[seeds],
    )
}
